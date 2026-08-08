import { describe, expect, it } from 'vitest';
import { ReasonerService, type Clock, type IdGenerator } from '@reasoner/core';
import { createStorage } from '@reasoner/storage';
import { createReasonerToolController } from '@reasoner/mcp';
import { isErr, isOk } from '@reasoner/schema';

class FixedClock implements Clock {
  now(): string {
    return '2026-01-01T00:00:00.000Z';
  }
}

class SeqIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();
  newId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }
}

const newController = () => {
  const clock = new FixedClock();
  const storage = createStorage({ dataDir: ':memory:', clock });
  const service = new ReasonerService({
    repository: storage.repository,
    clock,
    ids: new SeqIdGenerator(),
    audit: storage.audit,
  });
  return { controller: createReasonerToolController(service), storage };
};

/** The agreed tool surface. Adding or renaming a tool must be a deliberate edit here. */
const EXPECTED_TOOLS = [
  'create_reasoning_session',
  'get_reasoning_session',
  'list_reasoning_sessions',
  'finish_reasoning_session',
  'add_state_vertex',
  'add_evidence_vertex',
  'get_vertex',
  'propose_inference_edge',
  'get_inference_edge',
  'list_candidate_edges',
  'claim_inference_edge',
  'claim_inference_edges',
  'release_inference_edge',
  'answer_evidence_question',
  'complete_inference_edge',
  'block_inference_edge',
  'get_context_for_vertex',
  'get_context_for_edge',
  'get_reasoning_context',
] as const;

describe('MCP tool surface', () => {
  it('exposes exactly the 19 agreed tools', () => {
    const { controller, storage } = newController();
    const names = controller.names();

    expect(names).toHaveLength(19);
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
    storage.close();
  });

  it('gives every tool a title, description and input schema', () => {
    const { controller, storage } = newController();
    for (const tool of controller.list()) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
    storage.close();
  });

  it('marks read-only tools as non-mutating', () => {
    const { controller, storage } = newController();
    const readOnly = new Set([
      'get_reasoning_session',
      'list_reasoning_sessions',
      'get_vertex',
      'get_inference_edge',
      'list_candidate_edges',
      'get_context_for_vertex',
      'get_context_for_edge',
      'get_reasoning_context',
    ]);
    for (const tool of controller.list()) {
      expect(tool.mutating).toBe(!readOnly.has(tool.name));
    }
    storage.close();
  });
});

describe('MCP input validation', () => {
  it('rejects an unknown tool with a structured error', async () => {
    const { controller, storage } = newController();
    const result = await controller.invoke('no_such_tool', {});
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('InvalidInput');
    storage.close();
  });

  it('rejects malformed input without throwing', async () => {
    const { controller, storage } = newController();
    const result = await controller.invoke('create_reasoning_session', { goalLabel: 42 });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('InvalidInput');
      expect(Array.isArray(result.error.detail['issues'])).toBe(true);
    }
    storage.close();
  });

  it('reports a missing session as SessionNotFound, not a crash', async () => {
    const { controller, storage } = newController();
    const result = await controller.invoke('get_reasoning_session', {
      sessionId: 'session-does-not-exist',
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('SessionNotFound');
    storage.close();
  });

  it('applies schema defaults so optional fields need not be sent', async () => {
    const { controller, storage } = newController();
    const result = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'minimal input',
    });
    expect(isOk(result)).toBe(true);
    storage.close();
  });
});

describe('MCP end-to-end tool flow', () => {
  it('drives a full reasoning cycle through the controller only', async () => {
    const { controller, storage } = newController();

    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'prove the conclusion',
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    const session = (created.value as { session: { sessionId: string; graphRevision: number } })
      .session;

    const premise = await controller.invoke('add_state_vertex', {
      sessionId: session.sessionId,
      baseGraphRevision: session.graphRevision,
      agentId: 'agent-a',
      label: 'premise',
    });
    if (!isOk(premise)) throw new Error('premise failed');
    const premiseOut = premise.value as {
      vertex: { vertexId: string };
      graphRevision: number;
    };

    const conclusion = await controller.invoke('add_state_vertex', {
      sessionId: session.sessionId,
      baseGraphRevision: premiseOut.graphRevision,
      agentId: 'agent-a',
      label: 'conclusion',
    });
    if (!isOk(conclusion)) throw new Error('conclusion failed');
    const conclusionOut = conclusion.value as {
      vertex: { vertexId: string };
      graphRevision: number;
    };

    const proposed = await controller.invoke('propose_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: conclusionOut.graphRevision,
      agentId: 'agent-a',
      sourceVertexIds: [premiseOut.vertex.vertexId],
      targetVertexIds: [conclusionOut.vertex.vertexId],
      label: 'premise implies conclusion',
      evidenceQuestions: [{ prompt: 'What is the supporting evidence?' }],
    });
    if (!isOk(proposed)) throw new Error('propose failed');
    const proposedOut = proposed.value as {
      edge: { edgeId: string; evidenceQuestions: Array<{ questionId: string }> };
      graphRevision: number;
    };

    const claimed = await controller.invoke('claim_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: proposedOut.graphRevision,
      agentId: 'agent-a',
      edgeId: proposedOut.edge.edgeId,
    });
    if (!isOk(claimed)) throw new Error('claim failed');
    const claimedOut = claimed.value as {
      leaseId: string;
      graphRevision: number;
      context: { contextHash: string };
    };

    // An unanswered evidence question must block completion.
    const premature = await controller.invoke('complete_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: claimedOut.graphRevision,
      agentId: 'agent-a',
      edgeId: proposedOut.edge.edgeId,
      leaseId: claimedOut.leaseId,
      inputContextHash: claimedOut.context.contextHash,
      conclusion: 'too early',
    });
    expect(isErr(premature)).toBe(true);

    const answered = await controller.invoke('answer_evidence_question', {
      sessionId: session.sessionId,
      baseGraphRevision: claimedOut.graphRevision,
      agentId: 'agent-a',
      edgeId: proposedOut.edge.edgeId,
      leaseId: claimedOut.leaseId,
      questionId: proposedOut.edge.evidenceQuestions[0]?.questionId ?? '',
      answer: 'documented evidence',
    });
    if (!isOk(answered)) throw new Error('answer failed');
    const answeredOut = answered.value as { graphRevision: number };

    // The claim-time hash stays valid: answering is the holder's own work and
    // does not count as the edge changing underneath them.
    const completed = await controller.invoke('complete_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: answeredOut.graphRevision,
      agentId: 'agent-a',
      edgeId: proposedOut.edge.edgeId,
      leaseId: claimedOut.leaseId,
      inputContextHash: claimedOut.context.contextHash,
      conclusion: 'the conclusion holds',
    });
    if (!isOk(completed)) throw new Error('complete failed');
    expect((completed.value as { edge: { state: string } }).edge.state).toBe('Completed');

    storage.close();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { ReasonerService, type Clock, type IdGenerator } from '@reasoner/core';
import { createStorage, type StorageRuntime } from '@reasoner/storage';
import {
  isErr,
  isOk,
  type AgentId,
  type EdgeId,
  type GraphRevision,
  type SessionId,
  type VertexId,
} from '@reasoner/schema';

/** Deterministic clock so lease expiry can be driven explicitly. */
class TestClock implements Clock {
  private current = Date.parse('2026-01-01T00:00:00.000Z');
  now(): string {
    return new Date(this.current).toISOString();
  }
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
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

const AGENT_A = 'agent-a' as AgentId;
const AGENT_B = 'agent-b' as AgentId;

interface Harness {
  storage: StorageRuntime;
  service: ReasonerService;
  clock: TestClock;
}

const newHarness = (): Harness => {
  const clock = new TestClock();
  const storage = createStorage({ dataDir: ':memory:', clock });
  const service = new ReasonerService({
    repository: storage.repository,
    clock,
    ids: new SeqIdGenerator(),
    audit: storage.audit,
  });
  return { storage, service, clock };
};

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

/** Creates a session with two premise vertices and one conclusion vertex. */
const seedSession = async (h: Harness) => {
  const created = unwrap(
    await h.service.createReasoningSession({
      agentId: AGENT_A,
      goalLabel: 'goal',
      goalPayload: {},
      strategy: 'DFS',
      projectionPolicy: 'DependencySubgraphWithGlobalSummary',
    }),
  );
  const sessionId = created.session.sessionId;
  let revision = created.session.graphRevision;

  const premiseA = unwrap(
    await h.service.addStateVertex({
      sessionId,
      baseGraphRevision: revision,
      agentId: AGENT_A,
      label: 'premise A',
      payload: {},
    }),
  );
  revision = premiseA.graphRevision;

  const premiseB = unwrap(
    await h.service.addStateVertex({
      sessionId,
      baseGraphRevision: revision,
      agentId: AGENT_A,
      label: 'premise B',
      payload: {},
    }),
  );
  revision = premiseB.graphRevision;

  return {
    sessionId,
    revision,
    goalVertexId: created.goalVertex.vertexId,
    premiseAId: premiseA.vertex.vertexId,
    premiseBId: premiseB.vertex.vertexId,
  };
};

describe('storage: event sequencing', () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness();
  });

  it('assigns distinct eventSeq to events sharing one graphRevision', async () => {
    const created = unwrap(
      await h.service.createReasoningSession({
        agentId: AGENT_A,
        goalLabel: 'goal',
        goalPayload: {},
        strategy: 'DFS',
        projectionPolicy: 'DependencySubgraphWithGlobalSummary',
      }),
    );

    const context = unwrap(
      await h.service.getReasoningContext({
        sessionId: created.session.sessionId,
        afterEventSeq: 0,
        eventLimit: 100,
      }),
    );

    // SessionCreated + VertexAdded were written by one transaction.
    expect(context.events.length).toBe(2);
    expect(context.events[0]?.graphRevision).toBe(context.events[1]?.graphRevision);
    expect(context.events[0]?.eventSeq).toBe(1);
    expect(context.events[1]?.eventSeq).toBe(2);
  });

  it('pages by eventSeq without gaps or repeats', async () => {
    const seed = await seedSession(h);
    const all = unwrap(
      await h.service.getReasoningContext({
        sessionId: seed.sessionId,
        afterEventSeq: 0,
        eventLimit: 100,
      }),
    );
    const seqs = all.events.map((event) => event.eventSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const page = unwrap(
      await h.service.getReasoningContext({
        sessionId: seed.sessionId,
        afterEventSeq: 2,
        eventLimit: 100,
      }),
    );
    expect(page.events.every((event) => event.eventSeq > 2)).toBe(true);
  });
});

describe('storage: revision compare-and-set', () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness();
  });

  it('rejects a stale baseGraphRevision', async () => {
    const seed = await seedSession(h);
    const stale = (seed.revision - 1) as GraphRevision;

    const result = await h.service.addStateVertex({
      sessionId: seed.sessionId,
      baseGraphRevision: stale,
      agentId: AGENT_A,
      label: 'late arrival',
      payload: {},
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('RevisionConflict');
  });

  it('does not consume a revision on an idempotent dedupe hit', async () => {
    const seed = await seedSession(h);
    const again = unwrap(
      await h.service.addStateVertex({
        sessionId: seed.sessionId,
        baseGraphRevision: seed.revision,
        agentId: AGENT_A,
        label: 'premise A',
        payload: {},
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.graphRevision).toBe(seed.revision);
  });
});

describe('storage: cycle rejection leaves no trace', () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness();
  });

  it('rejects a completion that would close a loop, without bumping revision', async () => {
    const seed = await seedSession(h);
    let revision = seed.revision;

    // A -> B
    const forward = unwrap(
      await h.service.proposeInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        sourceVertexIds: [seed.premiseAId],
        targetVertexIds: [seed.premiseBId],
        label: 'a implies b',
        cost: 1,
        priority: 0,
        evidenceQuestions: [],
      }),
    );
    revision = forward.graphRevision;

    const claimForward = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        edgeId: forward.edge.edgeId,
      }),
    );
    revision = claimForward.graphRevision;

    const completedForward = unwrap(
      await h.service.completeInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        edgeId: forward.edge.edgeId,
        leaseId: claimForward.leaseId,
        inputContextHash: claimForward.context.contextHash,
        conclusion: 'b holds',
      }),
    );
    revision = completedForward.graphRevision;

    // Now propose the reverse B -> A and try to complete it.
    const backward = unwrap(
      await h.service.proposeInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        sourceVertexIds: [seed.premiseBId],
        targetVertexIds: [seed.premiseAId],
        label: 'b implies a',
        cost: 1,
        priority: 0,
        evidenceQuestions: [],
      }),
    );
    revision = backward.graphRevision;

    const claimBackward = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        edgeId: backward.edge.edgeId,
      }),
    );
    revision = claimBackward.graphRevision;

    const before = unwrap(
      await h.service.getReasoningContext({
        sessionId: seed.sessionId,
        afterEventSeq: 0,
        eventLimit: 500,
      }),
    );

    const cycle = await h.service.completeInferenceEdge({
      sessionId: seed.sessionId,
      baseGraphRevision: revision,
      agentId: AGENT_A,
      edgeId: backward.edge.edgeId,
      leaseId: claimBackward.leaseId,
      inputContextHash: claimBackward.context.contextHash,
      conclusion: 'a holds',
    });

    expect(isErr(cycle)).toBe(true);
    if (isErr(cycle)) expect(cycle.error.code).toBe('CycleDetected');

    const after = unwrap(
      await h.service.getReasoningContext({
        sessionId: seed.sessionId,
        afterEventSeq: 0,
        eventLimit: 500,
      }),
    );

    // No revision bump, no new events, edge still Leased rather than Completed.
    expect(after.snapshot.graphRevision).toBe(before.snapshot.graphRevision);
    expect(after.events.length).toBe(before.events.length);
    expect(
      after.snapshot.edges.find((edge) => edge.edgeId === backward.edge.edgeId)?.state,
    ).toBe('Leased');
    expect(after.events.some((event) => event.kind === 'EdgeCompleted' && event.edgeId === backward.edge.edgeId)).toBe(false);
  });
});

describe('storage: lease concurrency', () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness();
  });

  const seedTwoCandidates = async () => {
    const seed = await seedSession(h);
    let revision = seed.revision;

    const conclusion1 = unwrap(
      await h.service.addStateVertex({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        label: 'conclusion one',
        payload: {},
      }),
    );
    revision = conclusion1.graphRevision;

    const conclusion2 = unwrap(
      await h.service.addStateVertex({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        label: 'conclusion two',
        payload: {},
      }),
    );
    revision = conclusion2.graphRevision;

    const edge1 = unwrap(
      await h.service.proposeInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        sourceVertexIds: [seed.premiseAId],
        targetVertexIds: [conclusion1.vertex.vertexId],
        label: 'edge one',
        cost: 1,
        priority: 0,
        evidenceQuestions: [],
      }),
    );
    revision = edge1.graphRevision;

    const edge2 = unwrap(
      await h.service.proposeInferenceEdge({
        sessionId: seed.sessionId,
        baseGraphRevision: revision,
        agentId: AGENT_A,
        sourceVertexIds: [seed.premiseBId],
        targetVertexIds: [conclusion2.vertex.vertexId],
        label: 'edge two',
        cost: 1,
        priority: 0,
        evidenceQuestions: [],
      }),
    );
    revision = edge2.graphRevision;

    return { seed, revision, edge1: edge1.edge.edgeId, edge2: edge2.edge.edgeId };
  };

  it('allows only one agent to hold a lease on the same edge', async () => {
    const ctx = await seedTwoCandidates();

    const first = await h.service.claimInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: ctx.revision,
      agentId: AGENT_A,
      edgeId: ctx.edge1,
    });
    expect(isOk(first)).toBe(true);
    const revisionAfterFirst = unwrap(first).graphRevision;

    const second = await h.service.claimInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: revisionAfterFirst,
      agentId: AGENT_B,
      edgeId: ctx.edge1,
    });
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error.code).toBe('EdgeNotClaimable');
  });

  it('lets different agents hold leases on different edges', async () => {
    const ctx = await seedTwoCandidates();

    const first = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: ctx.revision,
        agentId: AGENT_A,
        edgeId: ctx.edge1,
      }),
    );
    const second = await h.service.claimInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: first.graphRevision,
      agentId: AGENT_B,
      edgeId: ctx.edge2,
    });
    expect(isOk(second)).toBe(true);
  });

  /**
   * Regression guard for the reclaim/claim transaction boundary: reclaiming an
   * expired lease must share the claim's revision bump. If it committed
   * separately the caller's compare-and-set would fail against the revision its
   * own cleanup produced.
   */
  it('reclaims an expired lease and claims in one revision, without RevisionConflict', async () => {
    const ctx = await seedTwoCandidates();

    const first = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: ctx.revision,
        agentId: AGENT_A,
        edgeId: ctx.edge1,
        leaseSeconds: 60,
      }),
    );

    h.clock.advanceSeconds(120);

    const reclaimed = await h.service.claimInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: first.graphRevision,
      agentId: AGENT_B,
      edgeId: ctx.edge1,
      leaseSeconds: 60,
    });

    expect(isOk(reclaimed)).toBe(true);
    const value = unwrap(reclaimed);
    expect(value.edge.lease?.agentId).toBe(AGENT_B);
    // Exactly one revision consumed for reclaim + claim together.
    expect(value.graphRevision).toBe(first.graphRevision + 1);
  });

  it('rejects completion from an agent whose lease expired', async () => {
    const ctx = await seedTwoCandidates();

    const claim = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: ctx.revision,
        agentId: AGENT_A,
        edgeId: ctx.edge1,
        leaseSeconds: 60,
      }),
    );

    h.clock.advanceSeconds(120);

    const result = await h.service.completeInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: claim.graphRevision,
      agentId: AGENT_A,
      edgeId: ctx.edge1,
      leaseId: claim.leaseId,
      inputContextHash: claim.context.contextHash,
      conclusion: 'too late',
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LeaseExpired');
  });

  /**
   * Regression guard for the context-hash rule: the completion hash is compared
   * against the archive taken at claim time and covers only that edge's own
   * material. Unrelated progress by another agent must not invalidate a claim,
   * or parallel agents could never finish.
   */
  it('lets an agent complete its edge after another agent advanced the graph', async () => {
    const ctx = await seedTwoCandidates();

    const claimA = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: ctx.revision,
        agentId: AGENT_A,
        edgeId: ctx.edge1,
      }),
    );

    const claimB = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: claimA.graphRevision,
        agentId: AGENT_B,
        edgeId: ctx.edge2,
      }),
    );

    // B finishes first, moving the session revision forward.
    const completedB = unwrap(
      await h.service.completeInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: claimB.graphRevision,
        agentId: AGENT_B,
        edgeId: ctx.edge2,
        leaseId: claimB.leaseId,
        inputContextHash: claimB.context.contextHash,
        conclusion: 'edge two done',
      }),
    );

    // A still completes with the hash it was handed at claim time.
    const completedA = await h.service.completeInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: completedB.graphRevision,
      agentId: AGENT_A,
      edgeId: ctx.edge1,
      leaseId: claimA.leaseId,
      inputContextHash: claimA.context.contextHash,
      conclusion: 'edge one done',
    });

    expect(isOk(completedA)).toBe(true);
    if (isErr(completedA)) throw new Error('expected A to complete');
    expect(completedA.value.edge.state).toBe('Completed');
  });

  it('rejects completion when the edge itself changed since the claim', async () => {
    const ctx = await seedTwoCandidates();

    const claim = unwrap(
      await h.service.claimInferenceEdge({
        sessionId: ctx.seed.sessionId,
        baseGraphRevision: ctx.revision,
        agentId: AGENT_A,
        edgeId: ctx.edge1,
      }),
    );

    const result = await h.service.completeInferenceEdge({
      sessionId: ctx.seed.sessionId,
      baseGraphRevision: claim.graphRevision,
      agentId: AGENT_A,
      edgeId: ctx.edge1,
      leaseId: claim.leaseId,
      inputContextHash: 'f'.repeat(64),
      conclusion: 'mismatched hash',
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('ContextStale');
  });
});

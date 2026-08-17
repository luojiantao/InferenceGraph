import { describe, expect, it } from 'vitest';
import { ReasonerService, type Clock, type IdGenerator } from '@reasoner/core';
import { createStorage } from '@reasoner/storage';
import { createReasonerToolController, registerReasonerTools } from '@reasoner/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetReasoningContextOutputSchema, isErr, isOk } from '@reasoner/schema';

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
  'update_reasoning_session_metadata',
  'delete_reasoning_session',
  'increase_reasoning_session_edge_budget',
  'list_reasoning_sessions',
  'finish_reasoning_session',
  'add_state_vertex',
  'add_evidence_vertex',
  'get_vertex',
  'update_vertex',
  'propose_inference_edge',
  'get_inference_edge',
  'update_inference_edge',
  'list_candidate_edges',
  'claim_vertex_expansions',
  'set_vertex_expansion_state',
  'requeue_vertex_expansion',
  'claim_inference_edge',
  'claim_inference_edges',
  'release_inference_edge',
  'answer_evidence_question',
  'complete_inference_edge',
  'block_inference_edge',
  'get_context_for_vertex',
  'get_downstream_context_for_vertex',
  'get_reasoning_text_for_vertex',
  'get_context_for_edge',
  'get_reasoning_context',
] as const;

describe('MCP tool surface', () => {
  it('exposes exactly the 28 agreed tools', () => {
    const { controller, storage } = newController();
    const names = controller.names();

    expect(names).toHaveLength(29);
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


  it('preserves fields for refined tool schemas during MCP registration', () => {
    const { controller, storage } = newController();
    const schemas = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool: (
        name: string,
        definition: { inputSchema?: Record<string, unknown> },
      ): void => {
        schemas.set(name, definition.inputSchema ?? {});
      },
    } as unknown as McpServer;

    registerReasonerTools(server, controller);

    expect(Object.keys(schemas.get('update_vertex') ?? {})).toEqual(
      expect.arrayContaining(['sessionId', 'baseGraphRevision', 'agentId', 'vertexId']),
    );
    expect(Object.keys(schemas.get('update_inference_edge') ?? {})).toEqual(
      expect.arrayContaining(['sessionId', 'baseGraphRevision', 'agentId', 'edgeId']),
    );
    expect(Object.keys(schemas.get('set_vertex_expansion_state') ?? {})).toEqual(
      expect.arrayContaining([
        'sessionId',
        'baseGraphRevision',
        'agentId',
        'vertexId',
        'leaseId',
        'state',
      ]),
    );
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
      'get_downstream_context_for_vertex',
      'get_reasoning_text_for_vertex',
      'get_context_for_edge',
      'get_reasoning_context',
    ]);
    for (const tool of controller.list()) {
      expect(tool.mutating).toBe(!readOnly.has(tool.name));
    }
    storage.close();
  });

  it('marks vertex expansion claim and settlement as mutating', () => {
    const { controller, storage } = newController();
    const byName = new Map(controller.list().map((tool) => [tool.name, tool]));

    expect(byName.get('claim_vertex_expansions')?.mutating).toBe(true);
    expect(byName.get('set_vertex_expansion_state')?.mutating).toBe(true);
    expect(byName.get('requeue_vertex_expansion')?.mutating).toBe(true);
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

  it('reserves Vn and En identifiers for generated session references', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'goal',
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const session = (created.value as { session: { sessionId: string; graphRevision: number } })
      .session;

    const reservedVertex = await controller.invoke('add_state_vertex', {
      sessionId: session.sessionId,
      baseGraphRevision: session.graphRevision,
      agentId: 'agent-a',
      vertexId: 'V99',
      label: 'reserved vertex id',
    });
    expect(isErr(reservedVertex)).toBe(true);
    if (isErr(reservedVertex)) expect(reservedVertex.error.code).toBe('InvalidInput');

    const source = await controller.invoke('add_state_vertex', {
      sessionId: session.sessionId,
      baseGraphRevision: session.graphRevision,
      agentId: 'agent-a',
      label: 'source',
    });
    if (!isOk(source)) throw new Error('source creation failed');
    const sourceOut = source.value as { graphRevision: number };

    const reservedEdge = await controller.invoke('propose_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: sourceOut.graphRevision,
      agentId: 'agent-a',
      edgeId: 'E99',
      sourceVertexIds: ['V2'],
      targetVertexIds: ['V1'],
      label: 'reserved edge id',
    });
    expect(isErr(reservedEdge)).toBe(true);
    if (isErr(reservedEdge)) expect(reservedEdge.error.code).toBe('InvalidInput');

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

  it('returns a compact formula-group structure from get_reasoning_context', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'goal',
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const createdOut = created.value as {
      session: { sessionId: string; graphRevision: number };
      goalVertex: { vertexId: string };
    };

    const premiseA = await controller.invoke('add_state_vertex', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: createdOut.session.graphRevision,
      agentId: 'agent-a',
      label: 'premise A',
    });
    if (!isOk(premiseA)) throw new Error('first premise creation failed');
    const premiseAOut = premiseA.value as {
      graphRevision: number;
      vertex: { vertexId: string };
    };

    const premiseB = await controller.invoke('add_state_vertex', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: premiseAOut.graphRevision,
      agentId: 'agent-a',
      label: 'premise B',
    });
    if (!isOk(premiseB)) throw new Error('second premise creation failed');
    const premiseBOut = premiseB.value as {
      graphRevision: number;
      vertex: { vertexId: string };
    };

    const proposed = await controller.invoke('propose_inference_edge', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: premiseBOut.graphRevision,
      agentId: 'agent-a',
      sourceVertexIds: [premiseAOut.vertex.vertexId, premiseBOut.vertex.vertexId],
      targetVertexIds: [createdOut.goalVertex.vertexId],
      label: 'both premises imply the goal',
    });
    if (!isOk(proposed)) throw new Error('formula proposal failed');
    const proposedOut = proposed.value as {
      edges: Array<{ edgeId: string; formulaId: string }>;
    };

    const context = await controller.invoke('get_reasoning_context', {
      sessionId: createdOut.session.sessionId,
    });
    if (!isOk(context)) throw new Error('reasoning context failed');
    const contextOut = context.value as {
      snapshot: { vertices: unknown[]; edges: unknown[] };
      reasoningStructure: {
        schemaVersion: number;
        formulaGroups: Array<{
          formulaId: string;
          sourceVertexIds: string[];
          targetVertexId: string;
          edgeIds: string[];
          state: string;
        }>;
      };
    };

    expect(contextOut.snapshot.vertices).toHaveLength(3);
    expect(contextOut.snapshot.edges).toHaveLength(2);
    expect(GetReasoningContextOutputSchema.safeParse(context.value).success).toBe(true);
    expect(contextOut.reasoningStructure.schemaVersion).toBe(1);
    expect(contextOut.reasoningStructure).not.toHaveProperty('vertices');
    expect(contextOut.reasoningStructure).not.toHaveProperty('edges');
    expect(contextOut.reasoningStructure.formulaGroups).toEqual([
      {
        formulaId: proposedOut.edges[0]?.formulaId,
        sourceVertexIds: [premiseAOut.vertex.vertexId, premiseBOut.vertex.vertexId].sort(),
        targetVertexId: createdOut.goalVertex.vertexId,
        edgeIds: proposedOut.edges.map((edge) => edge.edgeId).sort(),
        state: 'Candidate',
      },
    ]);

    storage.close();
  });

  it('raises a session edge budget with revision protection', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'budgeted goal',
      budget: { maxEdges: 1 },
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const session = (created.value as { session: { sessionId: string; graphRevision: number } })
      .session;

    const increased = await controller.invoke('increase_reasoning_session_edge_budget', {
      sessionId: session.sessionId,
      baseGraphRevision: session.graphRevision,
      agentId: 'agent-a',
      maxEdges: 4,
    });
    expect(isOk(increased)).toBe(true);
    if (!isOk(increased)) throw new Error('budget increase failed');
    const output = increased.value as {
      graphRevision: number;
      session: { budget: { maxEdges: number } };
    };
    expect(output.session.budget.maxEdges).toBe(4);

    const nonIncrease = await controller.invoke('increase_reasoning_session_edge_budget', {
      sessionId: session.sessionId,
      baseGraphRevision: output.graphRevision,
      agentId: 'agent-a',
      maxEdges: 4,
    });
    expect(isErr(nonIncrease)).toBe(true);
    if (isErr(nonIncrease)) expect(nonIncrease.error.code).toBe('InvalidInput');
    storage.close();
  });

  it('creates, updates and deletes complete session records with revision protection', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'metadata goal',
      alias: 'CAR1 调度阻塞',
      tags: ['调度', 'CAR1'],
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const createdOut = created.value as {
      session: { sessionId: string; graphRevision: number; alias?: string; tags: string[] };
    };
    expect(createdOut.session.alias).toBe('CAR1 调度阻塞');
    expect(createdOut.session.tags).toEqual(['调度', 'CAR1']);

    const updated = await controller.invoke('update_reasoning_session_metadata', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: createdOut.session.graphRevision,
      agentId: 'agent-a',
      alias: 'CAR1 回放',
      tags: ['回放', '阻塞定位'],
    });
    if (!isOk(updated)) throw new Error('metadata update failed');
    const updatedOut = updated.value as {
      graphRevision: number;
      session: { alias?: string; tags: string[] };
    };
    expect(updatedOut.session.alias).toBe('CAR1 回放');
    expect(updatedOut.session.tags).toEqual(['回放', '阻塞定位']);

    const staleDelete = await controller.invoke('delete_reasoning_session', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: createdOut.session.graphRevision,
      agentId: 'agent-a',
      confirm: true,
    });
    expect(isErr(staleDelete)).toBe(true);
    if (isErr(staleDelete)) expect(staleDelete.error.code).toBe('RevisionConflict');

    const deleted = await controller.invoke('delete_reasoning_session', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: updatedOut.graphRevision,
      agentId: 'agent-a',
      confirm: true,
    });
    expect(isOk(deleted)).toBe(true);
    if (isOk(deleted))
      expect(deleted.value).toEqual({
        sessionId: createdOut.session.sessionId,
        deleted: true,
      });

    const missing = await controller.invoke('get_reasoning_session', {
      sessionId: createdOut.session.sessionId,
    });
    expect(isErr(missing)).toBe(true);
    if (isErr(missing)) expect(missing.error.code).toBe('SessionNotFound');
    storage.close();
  });

  it('resolves session-local Vn and En references in MCP tool inputs', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'goal',
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const createdOut = created.value as {
      session: { sessionId: string; graphRevision: number };
      goalVertex: { vertexId: string; referenceId: string };
    };
    const session = createdOut.session;
    expect(createdOut.goalVertex.referenceId).toBe('V1');

    const premise = await controller.invoke('add_state_vertex', {
      sessionId: session.sessionId,
      baseGraphRevision: session.graphRevision,
      agentId: 'agent-a',
      label: 'premise',
    });
    if (!isOk(premise)) throw new Error('premise creation failed');
    const premiseOut = premise.value as {
      vertex: { vertexId: string; referenceId: string };
      graphRevision: number;
    };
    expect(premiseOut.vertex.referenceId).toBe('V2');

    const conclusion = await controller.invoke('add_state_vertex', {
      sessionId: session.sessionId,
      baseGraphRevision: premiseOut.graphRevision,
      agentId: 'agent-a',
      label: 'conclusion',
    });
    if (!isOk(conclusion)) throw new Error('conclusion creation failed');
    const conclusionOut = conclusion.value as {
      vertex: { vertexId: string; referenceId: string };
      graphRevision: number;
    };
    expect(conclusionOut.vertex.referenceId).toBe('V3');

    const vertexContext = await controller.invoke('get_context_for_vertex', {
      sessionId: session.sessionId,
      vertexId: 'V2',
    });
    expect(isOk(vertexContext)).toBe(true);
    if (isOk(vertexContext)) {
      expect(
        (vertexContext.value as { context: { currentVertex: { vertexId: string } } }).context
          .currentVertex.vertexId,
      ).toBe(premiseOut.vertex.vertexId);
    }

    const proposed = await controller.invoke('propose_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: conclusionOut.graphRevision,
      agentId: 'agent-a',
      sourceVertexIds: ['V2'],
      targetVertexIds: ['V3'],
      label: 'premise implies conclusion',
    });
    if (!isOk(proposed)) throw new Error('edge proposal failed');
    const proposedOut = proposed.value as {
      graphRevision: number;
      edge: { edgeId: string; referenceId: string };
    };
    expect(proposedOut.edge.referenceId).toBe('E1');

    const edge = await controller.invoke('get_inference_edge', {
      sessionId: session.sessionId,
      edgeId: 'E1',
    });
    expect(isOk(edge)).toBe(true);
    if (isOk(edge)) {
      expect((edge.value as { edge: { edgeId: string } }).edge.edgeId).toBe(
        proposedOut.edge.edgeId,
      );
    }

    const goalEdge = await controller.invoke('propose_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: proposedOut.graphRevision,
      agentId: 'agent-a',
      sourceVertexIds: ['V3'],
      targetVertexIds: ['V1'],
      label: 'conclusion implies goal',
    });
    if (!isOk(goalEdge)) throw new Error('goal edge proposal failed');

    const downstream = await controller.invoke('get_downstream_context_for_vertex', {
      sessionId: session.sessionId,
      vertexId: 'V2',
    });
    expect(isOk(downstream)).toBe(true);
    if (isOk(downstream)) {
      const context = (
        downstream.value as {
          context: {
            currentVertex: { vertexId: string };
            directDownstreamVertices: Array<{ vertexId: string }>;
            directDownstreamEdges: Array<{ referenceId: string }>;
            goalPathSummary: {
              reachable: boolean;
              hopCount: number | null;
              vertices: Array<{ referenceId: string }>;
              edges: Array<{ referenceId: string }>;
            };
          };
        }
      ).context;
      expect(context.currentVertex.vertexId).toBe(premiseOut.vertex.vertexId);
      expect(context.directDownstreamVertices.map((item) => item.vertexId)).toEqual([
        conclusionOut.vertex.vertexId,
      ]);
      expect(context.directDownstreamEdges.map((item) => item.referenceId)).toEqual(['E1']);
      expect(context.goalPathSummary).toMatchObject({ reachable: true, hopCount: 2 });
      expect(context.goalPathSummary.vertices.map((item) => item.referenceId)).toEqual([
        'V2',
        'V3',
        'V1',
      ]);
      expect(context.goalPathSummary.edges.map((item) => item.referenceId)).toEqual(['E1', 'E2']);
    }

    storage.close();
  });

  it('updates editable vertex and candidate edge fields through Vn and En references', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'manual edit goal',
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const createdOut = created.value as {
      session: { sessionId: string; graphRevision: number };
      goalVertex: { vertexId: string };
    };

    const premise = await controller.invoke('add_state_vertex', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: createdOut.session.graphRevision,
      agentId: 'agent-a',
      label: 'original premise',
      payload: { source: 'agent' },
    });
    if (!isOk(premise)) throw new Error('premise creation failed');
    const premiseOut = premise.value as { graphRevision: number; vertex: { vertexId: string } };

    const updatedVertex = await controller.invoke('update_vertex', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: premiseOut.graphRevision,
      agentId: 'agent-a',
      vertexId: 'V2',
      label: 'corrected premise',
      payload: { source: 'operator', reviewed: true },
    });
    if (!isOk(updatedVertex)) throw new Error('vertex update failed');
    const vertexOut = updatedVertex.value as {
      graphRevision: number;
      vertex: { referenceId: string; label: string; payload: Record<string, unknown> };
    };
    expect(vertexOut.vertex.referenceId).toBe('V2');
    expect(vertexOut.vertex.label).toBe('corrected premise');
    expect(vertexOut.vertex.payload).toEqual({ source: 'operator', reviewed: true });

    const proposed = await controller.invoke('propose_inference_edge', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: vertexOut.graphRevision,
      agentId: 'agent-a',
      sourceVertexIds: ['V2'],
      targetVertexIds: ['V1'],
      label: 'original relation',
      cost: 1,
      priority: 0,
      evidenceQuestions: [{ prompt: 'original question' }],
    });
    if (!isOk(proposed)) throw new Error('edge proposal failed');
    const edgeOut = proposed.value as {
      graphRevision: number;
      edge: { referenceId: string; evidenceQuestions: Array<{ questionId: string }> };
    };
    expect(edgeOut.edge.referenceId).toBe('E1');

    const updatedEdge = await controller.invoke('update_inference_edge', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: edgeOut.graphRevision,
      agentId: 'agent-a',
      edgeId: 'E1',
      label: 'corrected relation',
      cost: 2.5,
      priority: 8,
      evidenceQuestions: [
        {
          questionId: edgeOut.edge.evidenceQuestions[0]?.questionId,
          prompt: 'corrected question',
        },
      ],
    });
    if (!isOk(updatedEdge)) throw new Error('edge update failed');
    const updatedEdgeOut = updatedEdge.value as {
      graphRevision: number;
      edge: {
        referenceId: string;
        label: string;
        cost: number;
        priority: number;
        sourceVertexIds: string[];
        targetVertexIds: string[];
        evidenceQuestions: Array<{ prompt: string }>;
      };
    };
    expect(updatedEdgeOut.edge).toMatchObject({
      referenceId: 'E1',
      label: 'corrected relation',
      cost: 2.5,
      priority: 8,
      sourceVertexIds: [premiseOut.vertex.vertexId],
      targetVertexIds: [createdOut.goalVertex.vertexId],
    });
    expect(updatedEdgeOut.edge.evidenceQuestions).toMatchObject([{ prompt: 'corrected question' }]);

    const claimed = await controller.invoke('claim_inference_edge', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: updatedEdgeOut.graphRevision,
      agentId: 'agent-a',
      edgeId: 'E1',
    });
    if (!isOk(claimed)) throw new Error('edge claim failed');
    const claimedOut = claimed.value as { graphRevision: number };

    const rejectedWhileLeased = await controller.invoke('update_inference_edge', {
      sessionId: createdOut.session.sessionId,
      baseGraphRevision: claimedOut.graphRevision,
      agentId: 'agent-a',
      edgeId: 'E1',
      priority: 9,
    });
    expect(isErr(rejectedWhileLeased)).toBe(true);
    if (isErr(rejectedWhileLeased)) expect(rejectedWhileLeased.error.code).toBe('InvalidInput');

    storage.close();
  });

  it('expands Vn endpoint batches into independent En edges in one AND formula', async () => {
    const { controller, storage } = newController();
    const created = await controller.invoke('create_reasoning_session', {
      agentId: 'agent-a',
      goalLabel: 'target',
    });
    if (!isOk(created)) throw new Error('session creation failed');
    const createdOut = created.value as {
      session: { sessionId: string; graphRevision: number };
      goalVertex: { vertexId: string };
    };
    const session = createdOut.session;

    let revision = session.graphRevision;
    const premiseVertexIds: string[] = [];
    for (const label of ['first premise', 'second premise', 'third premise']) {
      const added = await controller.invoke('add_state_vertex', {
        sessionId: session.sessionId,
        baseGraphRevision: revision,
        agentId: 'agent-a',
        label,
      });
      if (!isOk(added)) throw new Error(`failed to add ${label}`);
      const output = added.value as { graphRevision: number; vertex: { vertexId: string } };
      revision = output.graphRevision;
      premiseVertexIds.push(output.vertex.vertexId);
    }

    const proposed = await controller.invoke('propose_inference_edge', {
      sessionId: session.sessionId,
      baseGraphRevision: revision,
      agentId: 'agent-a',
      sourceVertexIds: ['V2', 'V3', 'V4'],
      targetVertexIds: ['V1'],
      label: 'all premises jointly support the target',
      evidenceQuestions: [{ prompt: 'What supports this relation?' }],
    });
    if (!isOk(proposed)) throw new Error('batch proposal failed');
    const output = proposed.value as {
      edge: { referenceId: string };
      edges: Array<{
        referenceId: string;
        formulaId: string;
        sourceVertexIds: string[];
        targetVertexIds: string[];
        evidenceQuestions: Array<{ questionId: string }>;
      }>;
    };

    expect(output.edge.referenceId).toBe('E1');
    expect(output.edges.map((edge) => edge.referenceId)).toEqual(['E1', 'E2', 'E3']);
    expect(new Set(output.edges.map((edge) => edge.formulaId)).size).toBe(1);
    expect(output.edges.map((edge) => [edge.sourceVertexIds, edge.targetVertexIds])).toEqual(
      premiseVertexIds.map((vertexId) => [[vertexId], [createdOut.goalVertex.vertexId]]),
    );
    expect(output.edges.map((edge) => edge.evidenceQuestions.length)).toEqual([1, 1, 1]);

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

    const reasoningText = await controller.invoke('get_reasoning_text_for_vertex', {
      sessionId: session.sessionId,
      vertexId: 'V3',
    });
    expect(isOk(reasoningText)).toBe(true);
    if (isOk(reasoningText)) {
      const rendered = reasoningText.value as {
        context: { currentVertex: { vertexId: string } };
        mermaid: string;
        reasoningText: string;
      };
      expect(rendered.context.currentVertex.vertexId).toBe(conclusionOut.vertex.vertexId);
      expect(rendered.mermaid).toContain('flowchart TD');
      expect(rendered.mermaid).toContain('E1');
      expect(rendered.reasoningText).toContain('```mermaid');
      expect(rendered.reasoningText).toContain('边状态：Completed');
      expect(rendered.reasoningText).toContain('the conclusion holds');
    }

    storage.close();
  });
});

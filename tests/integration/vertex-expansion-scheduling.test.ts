import { describe, expect, it } from 'vitest';
import { ReasonerService, type Clock, type IdGenerator } from '@reasoner/core';
import { createStorage, migrateStorage } from '@reasoner/storage';
import type { AgentId, Result, SearchStrategy, VertexId } from '@reasoner/schema';

class FixedClock implements Clock {
  now(): string {
    return '2026-08-17T00:00:00.000Z';
  }
}

class SeqIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

  constructor(private readonly namespace = 'a') {}

  newId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${this.namespace}-${String(next).padStart(4, '0')}`;
  }
}

const AGENT_A = 'planner-a' as AgentId;
const AGENT_B = 'planner-b' as AgentId;

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

interface SeededTraversal {
  readonly service: ReasonerService;
  readonly storage: ReturnType<typeof createStorage>;
  readonly clock: FixedClock;
  readonly sessionId: string;
  readonly rootVertexId: VertexId;
  readonly firstPremiseId: VertexId;
  readonly secondPremiseId: VertexId;
  readonly deepPremiseId: VertexId;
  readonly graphRevision: number;
}

/**
 * Simulates one already-expanded root with two direct premises and one deeper
 * premise. The first real scheduling decision can therefore differ by DFS,
 * BFS and Priority rather than always claiming the new Goal first.
 */
const seedTraversal = async (
  strategy: SearchStrategy,
  priorities: readonly [number, number, number] = [0, 0, 0],
): Promise<SeededTraversal> => {
  const clock = new FixedClock();
  const storage = createStorage({ dataDir: ':memory:', clock, enableAudit: false });
  const service = new ReasonerService({
    repository: storage.repository,
    clock,
    ids: new SeqIdGenerator(),
    audit: storage.audit,
  });
  const created = unwrap(
    await service.createReasoningSession({
      agentId: AGENT_A,
      goalLabel: 'root',
      goalPayload: {},
      strategy,
      projectionPolicy: 'DependencySubgraphWithGlobalSummary',
    }),
  );
  const sessionId = created.session.sessionId;
  const rootVertexId = created.goalVertex.vertexId;

  // The first worker has already completed the root expansion.
  const rootClaim = unwrap(
    await service.claimVertexExpansions({
      sessionId,
      baseGraphRevision: created.session.graphRevision,
      agentId: AGENT_A,
      rootVertexId,
      maxVertices: 1,
    }),
  );
  const rootLeaseId = rootClaim.claims[0]?.leaseId;
  if (rootLeaseId === undefined) throw new Error('root claim was unexpectedly empty');
  const rootSettled = unwrap(
    await service.setVertexExpansionState({
      sessionId,
      baseGraphRevision: rootClaim.graphRevision,
      agentId: AGENT_A,
      vertexId: rootVertexId,
      leaseId: rootLeaseId,
      state: 'Expanded',
    }),
  );
  let graphRevision = rootSettled.graphRevision;

  const addState = async (label: string): Promise<VertexId> => {
    const added = unwrap(
      await service.addStateVertex({
        sessionId,
        baseGraphRevision: graphRevision,
        agentId: AGENT_A,
        label,
        payload: {},
      }),
    );
    graphRevision = added.graphRevision;
    return added.vertex.vertexId;
  };
  const propose = async (
    sourceVertexId: VertexId,
    targetVertexId: VertexId,
    priority: number,
  ): Promise<void> => {
    const proposed = unwrap(
      await service.proposeInferenceEdge({
        sessionId,
        baseGraphRevision: graphRevision,
        agentId: AGENT_A,
        sourceVertexIds: [sourceVertexId],
        targetVertexIds: [targetVertexId],
        label: `${sourceVertexId} supports ${targetVertexId}`,
        cost: 1,
        priority,
        evidenceQuestions: [],
      }),
    );
    graphRevision = proposed.graphRevision;
  };

  const firstPremiseId = await addState('first direct premise');
  const secondPremiseId = await addState('second direct premise');
  const deepPremiseId = await addState('deeper premise');
  await propose(firstPremiseId, rootVertexId, priorities[0]);
  await propose(secondPremiseId, rootVertexId, priorities[1]);
  await propose(deepPremiseId, firstPremiseId, priorities[2]);

  return {
    service,
    storage,
    clock,
    sessionId,
    rootVertexId,
    firstPremiseId,
    secondPremiseId,
    deepPremiseId,
    graphRevision,
  };
};

describe('vertex expansion scheduling', () => {
  it('uses the durable session strategy for reverse node selection', async () => {
    const bfs = await seedTraversal('BFS');
    const bfsClaim = unwrap(
      await bfs.service.claimVertexExpansions({
        sessionId: bfs.sessionId as never,
        baseGraphRevision: bfs.graphRevision,
        agentId: AGENT_A,
        rootVertexId: bfs.rootVertexId,
        maxVertices: 1,
      }),
    );
    expect(bfsClaim.claims[0]?.vertex.vertexId).toBe(bfs.firstPremiseId);
    bfs.storage.close();

    const dfs = await seedTraversal('DFS');
    const dfsClaim = unwrap(
      await dfs.service.claimVertexExpansions({
        sessionId: dfs.sessionId as never,
        baseGraphRevision: dfs.graphRevision,
        agentId: AGENT_A,
        rootVertexId: dfs.rootVertexId,
        maxVertices: 1,
      }),
    );
    expect(dfsClaim.claims[0]?.vertex.vertexId).toBe(dfs.deepPremiseId);
    dfs.storage.close();

    const priority = await seedTraversal('Priority', [1, 9, 3]);
    const priorityClaim = unwrap(
      await priority.service.claimVertexExpansions({
        sessionId: priority.sessionId as never,
        baseGraphRevision: priority.graphRevision,
        agentId: AGENT_A,
        rootVertexId: priority.rootVertexId,
        maxVertices: 1,
      }),
    );
    expect(priorityClaim.claims[0]?.vertex.vertexId).toBe(priority.secondPremiseId);
    priority.storage.close();
  });

  it('persists active claims, permits a future batch, and excludes already held vertices', async () => {
    const seeded = await seedTraversal('BFS');
    const firstBatch = unwrap(
      await seeded.service.claimVertexExpansions({
        sessionId: seeded.sessionId as never,
        baseGraphRevision: seeded.graphRevision,
        agentId: AGENT_A,
        rootVertexId: seeded.rootVertexId,
        maxVertices: 2,
      }),
    );
    const firstIds = firstBatch.claims.map((claim) => claim.vertex.vertexId);
    expect(firstIds).toEqual([seeded.firstPremiseId, seeded.secondPremiseId]);
    expect(new Set(firstBatch.claims.map((claim) => claim.leaseId)).size).toBe(2);
    expect(firstBatch.claims.every((claim) => claim.expansion.state === 'Expanding')).toBe(true);

    const context = unwrap(
      await seeded.service.getReasoningContext({
        sessionId: seeded.sessionId as never,
        afterEventSeq: 0,
        eventLimit: 100,
      }),
    );
    expect(context.activeExpansionVertexIds).toEqual(expect.arrayContaining(firstIds));
    expect(
      context.snapshot.vertexExpansions
        .filter((expansion) => firstIds.includes(expansion.vertexId))
        .every((expansion) => expansion.state === 'Expanding' && expansion.lease !== undefined),
    ).toBe(true);

    const secondCoordinator = new ReasonerService({
      repository: seeded.storage.repository,
      clock: seeded.clock,
      ids: new SeqIdGenerator('b'),
      audit: seeded.storage.audit,
    });
    const secondBatch = unwrap(
      await secondCoordinator.claimVertexExpansions({
        sessionId: seeded.sessionId as never,
        baseGraphRevision: firstBatch.graphRevision,
        agentId: AGENT_B,
        rootVertexId: seeded.rootVertexId,
        maxVertices: 2,
      }),
    );
    expect(secondBatch.claims.map((claim) => claim.vertex.vertexId)).toEqual([
      seeded.deepPremiseId,
    ]);
    expect(secondBatch.claims.some((claim) => firstIds.includes(claim.vertex.vertexId))).toBe(
      false,
    );
    seeded.storage.close();
  });

  it('keeps an AwaitingContext lease until the holder explicitly returns it to Pending', async () => {
    const clock = new FixedClock();
    const storage = createStorage({ dataDir: ':memory:', clock, enableAudit: false });
    const service = new ReasonerService({
      repository: storage.repository,
      clock,
      ids: new SeqIdGenerator(),
      audit: storage.audit,
    });
    const created = unwrap(
      await service.createReasoningSession({
        agentId: AGENT_A,
        goalLabel: 'needs context',
        goalPayload: {},
        strategy: 'DFS',
        projectionPolicy: 'DependencySubgraphWithGlobalSummary',
      }),
    );
    const sessionId = created.session.sessionId;
    const rootVertexId = created.goalVertex.vertexId;
    const claimed = unwrap(
      await service.claimVertexExpansions({
        sessionId,
        baseGraphRevision: created.session.graphRevision,
        agentId: AGENT_A,
        maxVertices: 1,
      }),
    );
    const leaseId = claimed.claims[0]?.leaseId;
    if (leaseId === undefined) throw new Error('goal claim was unexpectedly empty');
    const deferred = unwrap(
      await service.setVertexExpansionState({
        sessionId,
        baseGraphRevision: claimed.graphRevision,
        agentId: AGENT_A,
        vertexId: rootVertexId,
        leaseId,
        state: 'AwaitingContext',
        reason: 'need traceable log material',
      }),
    );
    expect(deferred.expansion).toMatchObject({ state: 'AwaitingContext', lease: { leaseId } });

    const secondCoordinator = new ReasonerService({
      repository: storage.repository,
      clock,
      ids: new SeqIdGenerator('b'),
      audit: storage.audit,
    });
    const blockedByLease = unwrap(
      await secondCoordinator.claimVertexExpansions({
        sessionId,
        baseGraphRevision: deferred.graphRevision,
        agentId: AGENT_B,
        maxVertices: 1,
      }),
    );
    expect(blockedByLease.claims).toEqual([]);

    const released = unwrap(
      await service.setVertexExpansionState({
        sessionId,
        baseGraphRevision: blockedByLease.graphRevision,
        agentId: AGENT_A,
        vertexId: rootVertexId,
        leaseId,
        state: 'Pending',
      }),
    );
    expect(released.expansion).toMatchObject({ state: 'Pending' });
    expect(released.expansion.lease).toBeUndefined();

    const reclaimed = unwrap(
      await secondCoordinator.claimVertexExpansions({
        sessionId,
        baseGraphRevision: released.graphRevision,
        agentId: AGENT_B,
        maxVertices: 1,
      }),
    );
    expect(reclaimed.claims[0]).toMatchObject({
      vertex: { vertexId: rootVertexId },
      expansion: { state: 'Expanding' },
    });
    storage.close();
  });

  it('backfills lifecycle rows for vertices stored before this scheduler existed', async () => {
    const clock = new FixedClock();
    const storage = createStorage({ dataDir: ':memory:', clock, enableAudit: false });
    const service = new ReasonerService({
      repository: storage.repository,
      clock,
      ids: new SeqIdGenerator(),
      audit: storage.audit,
    });
    const created = unwrap(
      await service.createReasoningSession({
        agentId: AGENT_A,
        goalLabel: 'legacy session',
        goalPayload: {},
        strategy: 'DFS',
        projectionPolicy: 'DependencySubgraphWithGlobalSummary',
      }),
    );
    const state = unwrap(
      await service.addStateVertex({
        sessionId: created.session.sessionId,
        baseGraphRevision: created.session.graphRevision,
        agentId: AGENT_A,
        label: 'legacy state',
        payload: {},
      }),
    );
    const evidence = unwrap(
      await service.addEvidenceVertex({
        sessionId: created.session.sessionId,
        baseGraphRevision: state.graphRevision,
        agentId: AGENT_A,
        label: 'legacy evidence',
        payload: {},
      }),
    );

    storage.db
      .prepare('DELETE FROM vertex_expansions WHERE session_id = ?')
      .run(created.session.sessionId);
    migrateStorage(storage.db);

    const restored = unwrap(
      await service.getReasoningContext({
        sessionId: created.session.sessionId,
        afterEventSeq: 0,
        eventLimit: 100,
      }),
    );
    const states = new Map(
      restored.snapshot.vertexExpansions.map((expansion) => [expansion.vertexId, expansion.state]),
    );
    expect(states.get(created.goalVertex.vertexId)).toBe('Pending');
    expect(states.get(state.vertex.vertexId)).toBe('Pending');
    expect(states.get(evidence.vertex.vertexId)).toBe('NotApplicable');
    storage.close();
  });
});

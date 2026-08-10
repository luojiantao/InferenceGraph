import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReasonerService, type Clock, type IdGenerator } from '@reasoner/core';
import { createStorage } from '@reasoner/storage';
import type { AgentId } from '@reasoner/schema';

class FixedClock implements Clock {
  private current = Date.parse('2026-01-01T00:00:00.000Z');
  now(): string {
    return new Date(this.current).toISOString();
  }
}

/**
 * Deterministic ids. `namespace` distinguishes generators across simulated
 * process restarts — a fresh counter would otherwise re-mint ids that already
 * exist, which the service correctly rejects as duplicates.
 */
class SeqIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();
  constructor(private readonly namespace = 'a') {}
  newId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${this.namespace}-${String(next).padStart(4, '0')}`;
  }
}

const AGENT = 'agent-a' as AgentId;

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const dirs: string[] = [];
const newDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoner-restart-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite WAL handle briefly after close();
      // leaving a temp directory behind must not fail the test.
    }
  }
});

describe('storage: restart recovery', () => {
  it('restores snapshot, frontier, revision and events from a reopened database', async () => {
    const dataDir = newDataDir();

    // --- first process lifetime ---
    const first = createStorage({ dataDir, clock: new FixedClock(), enableAudit: false });
    const firstService = new ReasonerService({
      repository: first.repository,
      clock: new FixedClock(),
      ids: new SeqIdGenerator(),
      audit: first.audit,
    });

    const created = unwrap(
      await firstService.createReasoningSession({
        agentId: AGENT,
        goalLabel: 'recoverable goal',
        goalPayload: { note: 'survives restart' },
        strategy: 'BFS',
        projectionPolicy: 'DependencySubgraphWithGlobalSummary',
      }),
    );
    const sessionId = created.session.sessionId;

    const premise = unwrap(
      await firstService.addStateVertex({
        sessionId,
        baseGraphRevision: created.session.graphRevision,
        agentId: AGENT,
        label: 'premise',
        payload: {},
      }),
    );

    const conclusion = unwrap(
      await firstService.addStateVertex({
        sessionId,
        baseGraphRevision: premise.graphRevision,
        agentId: AGENT,
        label: 'conclusion',
        payload: {},
      }),
    );

    const edge = unwrap(
      await firstService.proposeInferenceEdge({
        sessionId,
        baseGraphRevision: conclusion.graphRevision,
        agentId: AGENT,
        sourceVertexIds: [premise.vertex.vertexId],
        targetVertexIds: [conclusion.vertex.vertexId],
        label: 'premise implies conclusion',
        cost: 2,
        priority: 5,
        evidenceQuestions: [{ prompt: 'What supports this?' }],
      }),
    );

    const before = unwrap(
      await firstService.getReasoningContext({
        sessionId,
        afterEventSeq: 0,
        eventLimit: 500,
      }),
    );
    first.close();

    // --- second process lifetime, same directory ---
    const second = createStorage({ dataDir, clock: new FixedClock(), enableAudit: false });
    const secondService = new ReasonerService({
      repository: second.repository,
      clock: new FixedClock(),
      ids: new SeqIdGenerator('b'),
      audit: second.audit,
    });

    const after = unwrap(
      await secondService.getReasoningContext({
        sessionId,
        afterEventSeq: 0,
        eventLimit: 500,
      }),
    );

    expect(after.snapshot.graphRevision).toBe(before.snapshot.graphRevision);
    expect(after.snapshot.session.strategy).toBe('BFS');
    expect(after.snapshot.vertices.map((v) => v.vertexId).sort()).toEqual(
      before.snapshot.vertices.map((v) => v.vertexId).sort(),
    );
    expect(after.snapshot.vertices.map((v) => v.referenceId).sort()).toEqual(['V1', 'V2', 'V3']);
    expect(after.frontierEdgeIds).toEqual(before.frontierEdgeIds);
    expect(after.events.map((e) => e.eventSeq)).toEqual(before.events.map((e) => e.eventSeq));

    // Independent edge structure and edge-attribute questions survive the round trip.
    const restored = after.snapshot.edges.find((e) => e.edgeId === edge.edge.edgeId);
    expect(restored?.referenceId).toBe('E1');
    expect(restored?.sourceVertexIds).toEqual([premise.vertex.vertexId]);
    expect(restored?.targetVertexIds).toEqual([conclusion.vertex.vertexId]);
    expect(restored?.cost).toBe(2);
    expect(restored?.priority).toBe(5);
    expect(restored?.evidenceQuestions).toHaveLength(1);
    expect(restored?.evidenceQuestions[0]?.prompt).toBe('What supports this?');

    // The session remains writable at the recovered revision.
    const continued = await secondService.addStateVertex({
      sessionId,
      baseGraphRevision: after.snapshot.graphRevision,
      agentId: AGENT,
      label: 'added after restart',
      payload: {},
    });
    expect(continued.ok).toBe(true);
    if (continued.ok) expect(continued.value.vertex.referenceId).toBe('V4');

    second.close();
  });

  it('persists one AND formula per target while keeping every arrow independent across restart', async () => {
    const dataDir = newDataDir();
    const storage = createStorage({ dataDir, clock: new FixedClock(), enableAudit: false });
    const service = new ReasonerService({
      repository: storage.repository,
      clock: new FixedClock(),
      ids: new SeqIdGenerator(),
      audit: storage.audit,
    });

    const created = unwrap(
      await service.createReasoningSession({
        agentId: AGENT,
        goalLabel: 'independent edge goal',
        goalPayload: {},
        strategy: 'DFS',
        projectionPolicy: 'DependencySubgraphWithGlobalSummary',
      }),
    );
    const sessionId = created.session.sessionId;
    let revision = created.session.graphRevision;

    const ids: string[] = [];
    for (const label of ['s1', 's2', 't1', 't2']) {
      const vertex = unwrap(
        await service.addStateVertex({
          sessionId,
          baseGraphRevision: revision,
          agentId: AGENT,
          label,
          payload: {},
        }),
      );
      revision = vertex.graphRevision;
      ids.push(vertex.vertex.vertexId);
    }
    const [s1, s2, t1, t2] = ids as [string, string, string, string];

    const proposed = unwrap(
      await service.proposeInferenceEdge({
        sessionId,
        baseGraphRevision: revision,
        agentId: AGENT,
        sourceVertexIds: [s1, s2] as never,
        targetVertexIds: [t1, t2] as never,
        label: 'both sources jointly support each target',
        cost: 1,
        priority: 0,
        evidenceQuestions: [],
      }),
    );

    storage.close();

    const reopened = createStorage({ dataDir, clock: new FixedClock(), enableAudit: false });
    const reopenedService = new ReasonerService({
      repository: reopened.repository,
      clock: new FixedClock(),
      ids: new SeqIdGenerator('b'),
      audit: reopened.audit,
    });

    expect(proposed.edge.referenceId).toBe('E1');
    expect(proposed.edges.map((edge) => edge.referenceId)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(
      proposed.edges.map((edge) => [edge.sourceVertexIds[0], edge.targetVertexIds[0]]),
    ).toEqual([
      [s1, t1],
      [s1, t2],
      [s2, t1],
      [s2, t2],
    ]);
    expect(
      proposed.edges.every(
        (edge) => edge.sourceVertexIds.length === 1 && edge.targetVertexIds.length === 1,
      ),
    ).toBe(true);
    expect(proposed.edges[0]?.formulaId).toBe(proposed.edges[2]?.formulaId);
    expect(proposed.edges[1]?.formulaId).toBe(proposed.edges[3]?.formulaId);
    expect(proposed.edges[0]?.formulaId).not.toBe(proposed.edges[1]?.formulaId);

    const restored = unwrap(
      await reopenedService.getReasoningContext({
        sessionId,
        afterEventSeq: 0,
        eventLimit: 100,
      }),
    );

    expect(restored.snapshot.edges.map((edge) => edge.referenceId).sort()).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
    ]);
    expect(
      restored.snapshot.edges.map((edge) => [edge.sourceVertexIds[0], edge.targetVertexIds[0]]),
    ).toEqual(expect.arrayContaining([[s1, t1], [s1, t2], [s2, t1], [s2, t2]]));
    const byTarget = new Map<string, Set<string>>();
    for (const edge of restored.snapshot.edges) {
      const target = edge.targetVertexIds[0];
      if (target === undefined) continue;
      const formulaIds = byTarget.get(target) ?? new Set<string>();
      formulaIds.add(edge.formulaId);
      byTarget.set(target, formulaIds);
    }
    expect(byTarget.get(t1)?.size).toBe(1);
    expect(byTarget.get(t2)?.size).toBe(1);

    reopened.close();
  });
});

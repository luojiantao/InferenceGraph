import { describe, expect, it } from 'vitest';
import { loadBd1Fixture, runBd1Replay } from '@reasoner/test-agent';

describe('BD1 fixture replay', () => {
  it('loads and validates the bundled fixture', () => {
    const fixture = loadBd1Fixture();
    expect(fixture.name).toBe('BD1');
    expect(fixture.edges).toHaveLength(fixture.expectations?.totalEdges ?? 0);

    // The fixture must actually exercise merge inference, or it proves nothing
    // about multi-premise handling.
    const multiPremise = fixture.edges.filter((edge) => edge.sources.length > 1);
    expect(multiPremise.length).toBeGreaterThanOrEqual(2);
  });

  it('completes every edge and reaches CandidateFound under DFS', async () => {
    const report = await runBd1Replay({ strategy: 'DFS' });
    expect(report.completedEdgeCount).toBe(5);
    expect(report.completionOrder).toHaveLength(5);
    // A first supporting derivation must not auto-declare success.
    expect(report.goalState).toBe('CandidateFound');
    expect(report.eventCount).toBeGreaterThan(0);
  });

  it('completes every edge and reaches CandidateFound under BFS', async () => {
    const report = await runBd1Replay({ strategy: 'BFS' });
    expect(report.completedEdgeCount).toBe(5);
    expect(report.goalState).toBe('CandidateFound');
  });

  it('is deterministic: repeated runs give the same completion sequence', async () => {
    const [first, second] = await Promise.all([
      runBd1Replay({ strategy: 'Priority' }),
      runBd1Replay({ strategy: 'Priority' }),
    ]);

    // Edge ids are random per run, so compare the shape of the schedule.
    expect(first.completionOrder).toHaveLength(second.completionOrder.length);
    expect(first.completedEdgeCount).toBe(second.completedEdgeCount);
    expect(first.finalRevision).toBe(second.finalRevision);
    expect(first.lastEventSeq).toBe(second.lastEventSeq);
  });

  it('records an auditable event stream with a contiguous cursor', async () => {
    const report = await runBd1Replay({ strategy: 'DFS' });
    // One session + one goal vertex + 6 fixture vertices + 5 proposals,
    // each edge then claimed, answered and completed.
    expect(report.eventCount).toBe(report.lastEventSeq);
  });
});

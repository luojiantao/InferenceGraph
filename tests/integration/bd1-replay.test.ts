import { describe, expect, it } from 'vitest';
import { loadBd1Fixture, runBd1Replay } from '@reasoner/test-agent';

describe('BD1 fixture replay', () => {
  it('loads and validates the bundled fixture', () => {
    const fixture = loadBd1Fixture();
    expect(fixture.name).toBe('BD1');
    expect(fixture.edges).toHaveLength(fixture.expectations?.totalEdges ?? 0);

    // The fixture must exercise batch endpoint expansion into independent
    // relations, rather than only submitting one source->target pair.
    const multiPremise = fixture.edges.filter((edge) => edge.sources.length > 1);
    expect(multiPremise.length).toBeGreaterThanOrEqual(2);
  });

  it('completes every edge and reaches CandidateFound under DFS', async () => {
    const report = await runBd1Replay({ strategy: 'DFS' });
    expect(report.completedEdgeCount).toBe(8);
    expect(report.completionOrder).toHaveLength(8);
    // A first supporting derivation must not auto-declare success.
    expect(report.goalState).toBe('CandidateFound');
    expect(report.eventCount).toBeGreaterThan(0);
  });

  it('completes every edge and reaches CandidateFound under BFS', async () => {
    const report = await runBd1Replay({ strategy: 'BFS' });
    expect(report.completedEdgeCount).toBe(8);
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
    // Batch proposals may expand into several independent edge events; event
    // sequencing must nevertheless remain contiguous.
    expect(report.eventCount).toBe(report.lastEventSeq);
  });
});

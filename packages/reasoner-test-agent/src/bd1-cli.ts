import { runBd1Replay } from './bd1-replay.js';

/** CLI entry point for `pnpm replay:bd1`. Runs the fixture under DFS and BFS. */
const main = async (): Promise<void> => {
  for (const strategy of ['DFS', 'BFS'] as const) {
    const report = await runBd1Replay({ strategy });
    console.log(`\n=== BD1 replay (${strategy}) ===`);
    console.log(`session            ${report.sessionId}`);
    console.log(`final revision     ${report.finalRevision}`);
    console.log(`last event seq     ${report.lastEventSeq}`);
    console.log(`completed edges    ${report.completedEdgeCount}`);
    console.log(`goal state         ${report.goalState}`);
    console.log(`goal supported     ${report.goalSupported}`);
    console.log(`events recorded    ${report.eventCount}`);
    console.log(`completion order   ${report.completionOrder.join(' -> ')}`);
  }
  console.log('\nBD1 replay finished without contacting any external system.');
};

main().catch((cause: unknown) => {
  console.error('BD1 replay failed', cause);
  process.exit(1);
});

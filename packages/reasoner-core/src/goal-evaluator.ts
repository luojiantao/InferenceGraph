import type { GoalState, GraphSnapshot, VertexId } from '@reasoner/schema';
import { buildGraphIndex } from './graph-index.js';
import { baseVertexIds, toCompletedIncidenceGraph } from './graph-index.js';
import { isSupported, minimalHyperpath, type Hyperpath } from './graph-algorithms.js';

export interface GoalAssessment {
  /** True when the goal vertex is derivable through Completed edges only. */
  readonly goalSupported: boolean;
  readonly supportingPath: Hyperpath | null;
  readonly openCandidateCount: number;
  readonly blockedCount: number;
  readonly recommendedGoalState: GoalState;
  readonly rationale: string;
}

/**
 * Structural-only goal assessment. It reports whether the goal is *derivable*
 * from the completed subgraph; it never interprets what the vertices mean.
 *
 * Reaching a first supporting path yields CandidateFound rather than
 * GoalSatisfied: as long as candidates remain, an agent may still surface a
 * conflicting derivation, and the plan requires that verification step.
 * GoalSatisfied is only recommended once the frontier is exhausted.
 */
export const assessGoal = (snapshot: GraphSnapshot): GoalAssessment => {
  const index = buildGraphIndex(snapshot);
  const goalVertexId: VertexId = snapshot.session.goalVertexId;
  const completed = toCompletedIncidenceGraph(index);

  /**
   * The goal must be *derived*, never assumed. baseVertexIds() treats any vertex
   * with no completed incoming edge as a given, which would include the goal
   * itself and make it trivially supported, so it is excluded here.
   */
  const base = new Set(baseVertexIds(index));
  base.delete(goalVertexId);

  const goalSupported = isSupported(completed, goalVertexId, base);
  const supportingPath = goalSupported
    ? minimalHyperpath(completed, goalVertexId, base)
    : null;

  const openCandidateCount = snapshot.edges.filter((edge) => edge.state === 'Candidate').length;
  const leasedCount = snapshot.edges.filter((edge) => edge.state === 'Leased').length;
  const blockedCount = snapshot.edges.filter((edge) => edge.state === 'Blocked').length;
  const outstanding = openCandidateCount + leasedCount;

  let recommendedGoalState: GoalState;
  let rationale: string;

  if (goalSupported && outstanding === 0) {
    recommendedGoalState = 'GoalSatisfied';
    rationale = 'goal is supported by completed edges and no candidate or leased edge remains';
  } else if (goalSupported) {
    recommendedGoalState = 'CandidateFound';
    rationale = `goal is supported but ${outstanding} edge(s) still require verification`;
  } else if (outstanding === 0) {
    recommendedGoalState = blockedCount > 0 ? 'GoalConflicted' : 'Exhausted';
    rationale =
      blockedCount > 0
        ? `frontier is empty and ${blockedCount} edge(s) are blocked, so the goal cannot be derived`
        : 'frontier is empty and the goal is not supported by any completed derivation';
  } else {
    recommendedGoalState = 'Exploring';
    rationale = `goal is not yet supported; ${outstanding} edge(s) remain on the frontier`;
  }

  return {
    goalSupported,
    supportingPath,
    openCandidateCount,
    blockedCount,
    recommendedGoalState,
    rationale,
  };
};

/** Budget check run before admitting new edges. */
export const exceedsBudget = (snapshot: GraphSnapshot): boolean =>
  snapshot.edges.length >= snapshot.session.budget.maxEdges;

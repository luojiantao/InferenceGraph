import {
  buildInferenceFormulaGroups,
  type GraphSnapshot,
  type InferenceEdge,
  type ReasoningFormulaGroupState,
  type ReasoningStructure,
} from '@reasoner/schema';
import { assessGoal } from './goal-evaluator.js';

/**
 * Collapses component-edge lifecycle into the state of an AND formula.
 * Exact component state and all domain details remain in `snapshot.edges`.
 */
const formulaGroupState = (edges: readonly InferenceEdge[]): ReasoningFormulaGroupState => {
  if (edges.every((edge) => edge.state === 'Completed')) return 'Completed';
  if (
    edges.some(
      (edge) => edge.state === 'Blocked' || edge.state === 'Abandoned' || edge.state === 'Invalid',
    )
  ) {
    return 'Blocked';
  }
  if (edges.some((edge) => edge.state === 'Leased')) return 'Leased';
  return 'Candidate';
};

/**
 * Builds a compact, explicit view of the logical inference graph.
 *
 * The snapshot remains the single source of vertex and edge objects. This
 * structure only materializes formula membership, AND/OR semantics and a goal
 * assessment, which lets consumers summarize the graph without reconstructing
 * formula groups from every physical edge themselves.
 */
export const buildReasoningStructure = (snapshot: GraphSnapshot): ReasoningStructure => {
  const assessment = assessGoal(snapshot);

  return {
    schemaVersion: 1,
    formulaGroups: buildInferenceFormulaGroups(snapshot.edges).map((formula) => ({
      formulaId: formula.formulaId,
      sourceVertexIds: [...formula.sourceVertexIds].sort(),
      targetVertexId: formula.targetVertexId,
      edgeIds: [...formula.edgeIds].sort(),
      state: formulaGroupState(formula.edges),
    })),
    goalAssessment: {
      goalSupported: assessment.goalSupported,
      recommendedGoalState: assessment.recommendedGoalState,
      rationale: assessment.rationale,
    },
  };
};

import {
  buildInferenceFormulaGroups,
  type EdgeId,
  type InferenceEdge,
  type SearchStrategy,
  type VertexId,
} from '@reasoner/schema';
import { baseVertexIds, type GraphIndex } from './graph-index.js';

export interface FrontierEntry {
  readonly edgeId: EdgeId;
  readonly targetVertexIds: readonly VertexId[];
  readonly depth: number;
  readonly priority: number;
  /** Position in the deterministic selection order; 0 is picked first. */
  readonly rank: number;
}

/**
 * Depth of a vertex from root vertices, over fully completed formulae only.
 * A formula cannot contribute depth until every one of its direct operands is
 * complete, so a partial E1/E2/E3 group never makes its target look derived.
 */
const computeDepths = (index: GraphIndex): ReadonlyMap<VertexId, number> => {
  const depth = new Map<VertexId, number>();
  for (const vertexId of baseVertexIds(index)) depth.set(vertexId, 0);

  const completedFormulae = buildInferenceFormulaGroups(index.snapshot.edges).filter((formula) =>
    formula.edges.every((edge) => edge.state === 'Completed'),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const formula of completedFormulae) {
      const sourceDepths = formula.sourceVertexIds.map((sourceId) => depth.get(sourceId));
      if (sourceDepths.some((value) => value === undefined)) continue;
      const candidate = Math.max(...(sourceDepths as number[]), 0) + 1;
      const existing = depth.get(formula.targetVertexId);
      if (existing === undefined || candidate < existing) {
        depth.set(formula.targetVertexId, candidate);
        changed = true;
      }
    }
  }

  return depth;
};

const candidateEdges = (index: GraphIndex): readonly InferenceEdge[] =>
  index.snapshot.edges.filter((edge) => edge.state === 'Candidate');

/** Depth of a candidate edge = max depth over its premises, +1. */
const edgeDepth = (
  edge: InferenceEdge,
  depths: ReadonlyMap<VertexId, number>,
): number => {
  let deepest = 0;
  for (const sourceId of edge.sourceVertexIds) {
    deepest = Math.max(deepest, depths.get(sourceId) ?? 0);
  }
  return deepest + 1;
};

/**
 * Orders the candidate frontier for a strategy. Every comparison ends with a
 * tie-break on edgeId, so the order is total and reproducible — the property the
 * acceptance criteria require for auditability.
 *
 * DFS: deepest first. BFS: shallowest first. Priority: highest priority first.
 */
export const orderFrontier = (
  index: GraphIndex,
  strategy: SearchStrategy,
): readonly FrontierEntry[] => {
  const depths = computeDepths(index);
  const entries = candidateEdges(index).map((edge) => ({
    edgeId: edge.edgeId,
    targetVertexIds: edge.targetVertexIds,
    depth: edgeDepth(edge, depths),
    priority: edge.priority,
  }));

  const compare = (
    a: (typeof entries)[number],
    b: (typeof entries)[number],
  ): number => {
    switch (strategy) {
      case 'DFS': {
        if (a.depth !== b.depth) return b.depth - a.depth;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.edgeId < b.edgeId ? -1 : 1;
      }
      case 'BFS': {
        if (a.depth !== b.depth) return a.depth - b.depth;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.edgeId < b.edgeId ? -1 : 1;
      }
      case 'Priority': {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.edgeId < b.edgeId ? -1 : 1;
      }
    }
  };

  return [...entries]
    .sort(compare)
    .map((entry, position) => ({ ...entry, rank: position }));
};

/** The single edge a strategy would pick next, or null on an empty frontier. */
export const selectNextEdge = (
  index: GraphIndex,
  strategy: SearchStrategy,
): FrontierEntry | null => orderFrontier(index, strategy)[0] ?? null;

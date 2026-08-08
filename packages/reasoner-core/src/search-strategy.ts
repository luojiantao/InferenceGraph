import type { EdgeId, InferenceEdge, SearchStrategy, VertexId } from '@reasoner/schema';
import type { GraphIndex } from './graph-index.js';

export interface FrontierEntry {
  readonly edgeId: EdgeId;
  readonly targetVertexIds: readonly VertexId[];
  readonly depth: number;
  readonly priority: number;
  /** Position in the deterministic selection order; 0 is picked first. */
  readonly rank: number;
}

/**
 * Depth of a vertex from the session's root vertices, over Completed edges only.
 * A vertex reachable by several routes takes its shallowest depth.
 */
const computeDepths = (index: GraphIndex): ReadonlyMap<VertexId, number> => {
  const depth = new Map<VertexId, number>();
  const queue: VertexId[] = [];

  for (const vertex of index.snapshot.vertices) {
    const incoming = (index.incomingEdgeIds.get(vertex.vertexId) ?? []).filter(
      (edgeId) => index.edgeById.get(edgeId)?.state === 'Completed',
    );
    if (incoming.length === 0) {
      depth.set(vertex.vertexId, 0);
      queue.push(vertex.vertexId);
    }
  }
  queue.sort();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) continue;
    const currentDepth = depth.get(current) ?? 0;
    const outgoing = index.outgoingEdgeIds.get(current) ?? [];
    for (const edgeId of outgoing) {
      const edge = index.edgeById.get(edgeId);
      if (edge === undefined || edge.state !== 'Completed') continue;
      for (const targetId of edge.targetVertexIds) {
        const existing = depth.get(targetId);
        if (existing === undefined || currentDepth + 1 < existing) {
          depth.set(targetId, currentDepth + 1);
          queue.push(targetId);
        }
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

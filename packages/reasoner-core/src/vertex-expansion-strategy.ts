import type { GraphSnapshot, SearchStrategy, VertexExpansion, VertexId } from '@reasoner/schema';
import { buildGraphIndex } from './graph-index.js';
import { defaultVertexExpansion } from './vertex-expansion-coordinator.js';

export interface VertexExpansionFrontierEntry {
  readonly vertexId: VertexId;
  /** Reverse dependency distance from the selected root vertex. */
  readonly depth: number;
  /** Highest priority of an active relation that consumes this premise. */
  readonly priority: number;
  /** Position in the deterministic service-owned scheduling order. */
  readonly rank: number;
}

const retainedForExpansion = (state: string): boolean => state !== 'Abandoned' && state !== 'Invalid';

/**
 * Computes reverse dependency depth: an inference edge `premise -> target`
 * moves a planning traversal from `target` to `premise`.
 */
const computeReverseDepths = (
  snapshot: GraphSnapshot,
  rootVertexId: VertexId,
): ReadonlyMap<VertexId, number> => {
  const index = buildGraphIndex(snapshot);
  const depths = new Map<VertexId, number>([[rootVertexId, 0]]);
  const queue: VertexId[] = [rootVertexId];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const targetVertexId = queue[cursor];
    if (targetVertexId === undefined) continue;
    const depth = depths.get(targetVertexId);
    if (depth === undefined) continue;
    for (const edgeId of index.incomingEdgeIds.get(targetVertexId) ?? []) {
      const edge = index.edgeById.get(edgeId);
      if (edge === undefined || !retainedForExpansion(edge.state)) continue;
      for (const sourceVertexId of edge.sourceVertexIds) {
        const candidateDepth = depth + 1;
        const previous = depths.get(sourceVertexId);
        if (previous !== undefined && previous <= candidateDepth) continue;
        depths.set(sourceVertexId, candidateDepth);
        queue.push(sourceVertexId);
      }
    }
  }
  return depths;
};

const expansionPriority = (snapshot: GraphSnapshot, vertexId: VertexId): number => {
  const index = buildGraphIndex(snapshot);
  let highest = 0;
  for (const edgeId of index.outgoingEdgeIds.get(vertexId) ?? []) {
    const edge = index.edgeById.get(edgeId);
    if (edge !== undefined && retainedForExpansion(edge.state)) {
      highest = Math.max(highest, edge.priority);
    }
  }
  return highest;
};

const compare = (strategy: SearchStrategy) =>
  (left: Omit<VertexExpansionFrontierEntry, 'rank'>, right: Omit<VertexExpansionFrontierEntry, 'rank'>): number => {
    switch (strategy) {
      case 'DFS':
        if (left.depth !== right.depth) return right.depth - left.depth;
        if (left.priority !== right.priority) return right.priority - left.priority;
        return left.vertexId < right.vertexId ? -1 : 1;
      case 'BFS':
        if (left.depth !== right.depth) return left.depth - right.depth;
        if (left.priority !== right.priority) return right.priority - left.priority;
        return left.vertexId < right.vertexId ? -1 : 1;
      case 'Priority':
        if (left.priority !== right.priority) return right.priority - left.priority;
        if (left.depth !== right.depth) return left.depth - right.depth;
        return left.vertexId < right.vertexId ? -1 : 1;
    }
  };

/**
 * Orders reverse-planning targets. Unlike orderFrontier(), this operates on
 * vertices that still need their direct premises proposed; edge execution
 * keeps using the existing Candidate-edge frontier.
 */
export const orderVertexExpansionFrontier = (
  snapshot: GraphSnapshot,
  rootVertexId: VertexId,
  strategy: SearchStrategy,
): readonly VertexExpansionFrontierEntry[] => {
  const depths = computeReverseDepths(snapshot, rootVertexId);
  const stored = new Map(snapshot.vertexExpansions.map((expansion) => [expansion.vertexId, expansion]));
  const entries = snapshot.vertices.flatMap((vertex) => {
    if (vertex.kind === 'Evidence') return [];
    const depth = depths.get(vertex.vertexId);
    if (depth === undefined) return [];
    const expansion: VertexExpansion = stored.get(vertex.vertexId) ?? defaultVertexExpansion(vertex);
    if (expansion.state !== 'Pending') return [];
    return [
      {
        vertexId: vertex.vertexId,
        depth,
        priority: expansionPriority(snapshot, vertex.vertexId),
      },
    ];
  });

  return [...entries]
    .sort(compare(strategy))
    .map((entry, rank) => ({ ...entry, rank }));
};

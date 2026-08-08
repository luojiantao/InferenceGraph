import type { EdgeId, VertexId } from '@reasoner/schema';
import {
  hasSelfLoop,
  isReachable,
  stronglyConnectedComponents,
  type DirectedIncidenceGraph,
  type HyperedgeView,
} from './graph-theory.js';

/**
 * INFERENTIAL (AND) support.
 *
 * A hyperedge only fires when EVERY source vertex is supported. Base vertices
 * (those in `satisfied`) are supported by assumption. This is the semantics for
 * dependency collection and hyperpath search.
 *
 * Contrast with isReachable (OR): on a multi-premise graph the two disagree, and
 * that difference is asserted by the paired conformance test. Never substitute
 * one for the other.
 */
export const isSupported = (
  graph: DirectedIncidenceGraph,
  target: VertexId,
  satisfied: ReadonlySet<VertexId>,
): boolean => supportedSet(graph, satisfied).has(target);

/**
 * Forward least-fixed-point closure: repeatedly fire every hyperedge whose full
 * source set is already supported, until nothing new is added.
 */
export const supportedSet = (
  graph: DirectedIncidenceGraph,
  satisfied: ReadonlySet<VertexId>,
): ReadonlySet<VertexId> => {
  const supported = new Set<VertexId>(satisfied);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of graph.hyperedges) {
      // Fire only when every premise holds; then ALL conclusions become supported.
      const allPremisesMet = edge.sourceVertexIds.every((id) => supported.has(id));
      if (!allPremisesMet) continue;
      for (const targetId of edge.targetVertexIds) {
        if (supported.has(targetId)) continue;
        supported.add(targetId);
        grew = true;
      }
    }
  }
  return supported;
};

export interface HyperpathStep {
  readonly edgeId: EdgeId;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
  readonly cost: number;
}

export interface Hyperpath {
  readonly targetVertexId: VertexId;
  /** Steps in firing order: every step's premises precede it. */
  readonly steps: readonly HyperpathStep[];
  /** Sum of step costs; additive over the AND-tree, not a shortest walk. */
  readonly totalCost: number;
}

/**
 * INFERENTIAL (AND) minimum-cost hyperpath.
 *
 * Knuth's generalisation of shortest-path to hypergraphs: the cost of firing a
 * hyperedge is its own cost plus the SUM of its premises' costs, so a conclusion
 * pays for every branch of its support tree. A plain Dijkstra over pairwise
 * edges is wrong here and must not be used.
 *
 * Returns null when the target cannot be supported from `satisfied`.
 */
export const minimalHyperpath = (
  graph: DirectedIncidenceGraph,
  target: VertexId,
  satisfied: ReadonlySet<VertexId>,
): Hyperpath | null => {
  const cost = new Map<VertexId, number>();
  const via = new Map<VertexId, HyperedgeView>();
  for (const id of satisfied) cost.set(id, 0);

  // Bellman-Ford style relaxation: each pass may lower one more vertex's cost.
  for (let pass = 0; pass <= graph.hyperedges.length; pass += 1) {
    let improved = false;
    for (const edge of graph.hyperedges) {
      let premiseTotal = 0;
      let reachable = true;
      for (const sourceId of edge.sourceVertexIds) {
        const sourceCost = cost.get(sourceId);
        if (sourceCost === undefined) {
          reachable = false;
          break;
        }
        premiseTotal += sourceCost;
      }
      if (!reachable) continue;

      const candidate = premiseTotal + edge.cost;
      // Firing the edge derives every one of its conclusions at this cost.
      for (const targetId of edge.targetVertexIds) {
        const existing = cost.get(targetId);
        if (existing === undefined || candidate < existing) {
          cost.set(targetId, candidate);
          via.set(targetId, edge);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  const totalCost = cost.get(target);
  if (totalCost === undefined) return null;

  const steps: HyperpathStep[] = [];
  const emitted = new Set<EdgeId>();

  const emit = (vertexId: VertexId): void => {
    if (satisfied.has(vertexId)) return;
    const edge = via.get(vertexId);
    if (edge === undefined || emitted.has(edge.edgeId)) return;
    emitted.add(edge.edgeId);
    for (const sourceId of edge.sourceVertexIds) emit(sourceId);
    steps.push({
      edgeId: edge.edgeId,
      sourceVertexIds: edge.sourceVertexIds,
      targetVertexIds: edge.targetVertexIds,
      cost: edge.cost,
    });
  };
  emit(target);

  return { targetVertexId: target, steps, totalCost };
};

export interface CycleCheckResult {
  readonly hasCycle: boolean;
  /** Source vertices the proposed target can already reach, if any. */
  readonly offendingSourceIds: readonly VertexId[];
}

/**
 * Incremental pre-completion cycle check, run inside the same
 * `begin immediate` transaction as the write. A cycle exists when any proposed
 * target can already reach any of the proposed sources.
 *
 * Uses STRUCTURAL (OR) reachability on purpose: for DAG-ness any single arc
 * closing the loop is enough, regardless of premise satisfaction.
 */
export const checkCycleOnComplete = (
  completedGraph: DirectedIncidenceGraph,
  sourceVertexIds: readonly VertexId[],
  targetVertexIds: readonly VertexId[],
): CycleCheckResult => {
  const offending = new Set<VertexId>();
  for (const targetId of targetVertexIds) {
    for (const sourceId of sourceVertexIds) {
      if (sourceId === targetId || isReachable(completedGraph, targetId, sourceId)) {
        offending.add(sourceId);
      }
    }
  }
  const offendingSourceIds = [...offending].sort();
  return { hasCycle: offendingSourceIds.length > 0, offendingSourceIds };
};

export interface InvariantViolation {
  readonly kind: 'CyclicComponent' | 'SelfLoop' | 'DanglingReference';
  readonly detail: string;
}

/**
 * Runs on every session recovery. Any violation marks the session
 * non-continuable rather than letting the scheduler dispatch silently.
 */
export const validateGraphInvariants = (
  completedGraph: DirectedIncidenceGraph,
): readonly InvariantViolation[] => {
  const violations: InvariantViolation[] = [];
  const known = new Set(completedGraph.vertexIds);

  for (const edge of completedGraph.hyperedges) {
    for (const sourceId of edge.sourceVertexIds) {
      if (!known.has(sourceId)) {
        violations.push({
          kind: 'DanglingReference',
          detail: `edge ${edge.edgeId} references unknown source vertex ${sourceId}`,
        });
      }
    }
    for (const targetId of edge.targetVertexIds) {
      if (!known.has(targetId)) {
        violations.push({
          kind: 'DanglingReference',
          detail: `edge ${edge.edgeId} references unknown target vertex ${targetId}`,
        });
      }
    }
  }

  if (hasSelfLoop(completedGraph)) {
    violations.push({
      kind: 'SelfLoop',
      detail: 'a completed hyperedge lists its own target as a source',
    });
  }

  for (const component of stronglyConnectedComponents(completedGraph)) {
    if (component.elements.length > 1) {
      const members = component.elements.map((element) => `${element.kind}:${element.id}`).join(',');
      violations.push({
        kind: 'CyclicComponent',
        detail: `strongly connected component of size ${component.elements.length}: ${members}`,
      });
    }
  }

  return violations;
};

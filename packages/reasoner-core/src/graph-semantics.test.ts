import { describe, expect, it } from 'vitest';
import type { EdgeId, VertexId } from '@reasoner/schema';
import {
  isReachable,
  stronglyConnectedComponents,
  topologicalSort,
  type DirectedIncidenceGraph,
} from './graph-theory.js';
import {
  checkCycleOnComplete,
  isSupported,
  minimalHyperpath,
  validateGraphInvariants,
} from './graph-algorithms.js';

const v = (id: string): VertexId => id as VertexId;
const e = (id: string): EdgeId => id as EdgeId;

/**
 * a and b jointly imply c. Only a is satisfied.
 * OR semantics: c is reachable from a (a -> E1 -> c).
 * AND semantics: c is NOT supported, because premise b is missing.
 */
const multiPremiseGraph: DirectedIncidenceGraph = {
  vertexIds: [v('a'), v('b'), v('c')],
  hyperedges: [
    { edgeId: e('E1'), sourceVertexIds: [v('a'), v('b')], targetVertexIds: [v('c')], cost: 1 },
  ],
};

describe('structural (OR) vs inferential (AND) semantics', () => {
  it('disagree on a multi-premise hyperedge with a missing premise', () => {
    const structural = isReachable(multiPremiseGraph, v('a'), v('c'));
    const inferential = isSupported(multiPremiseGraph, v('c'), new Set([v('a')]));

    expect(structural).toBe(true);
    expect(inferential).toBe(false);
    // The red line: the two semantics must not be interchangeable.
    expect(structural).not.toBe(inferential);
  });

  it('agree once every premise is satisfied', () => {
    expect(isReachable(multiPremiseGraph, v('a'), v('c'))).toBe(true);
    expect(isSupported(multiPremiseGraph, v('c'), new Set([v('a'), v('b')]))).toBe(true);
  });

  it('AND closure fires chained hyperedges transitively', () => {
    const graph: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b'), v('c'), v('d')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a'), v('b')], targetVertexIds: [v('c')], cost: 1 },
        { edgeId: e('E2'), sourceVertexIds: [v('c')], targetVertexIds: [v('d')], cost: 1 },
      ],
    };
    expect(isSupported(graph, v('d'), new Set([v('a'), v('b')]))).toBe(true);
    expect(isSupported(graph, v('d'), new Set([v('a')]))).toBe(false);
  });
});

describe('minimalHyperpath', () => {
  it('sums every premise branch instead of taking a single shortest walk', () => {
    const graph: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b'), v('c'), v('d')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('c')], cost: 2 },
        { edgeId: e('E2'), sourceVertexIds: [v('b')], targetVertexIds: [v('d')], cost: 3 },
        { edgeId: e('E3'), sourceVertexIds: [v('c'), v('d')], targetVertexIds: [v('goal')], cost: 1 },
      ],
    };
    const path = minimalHyperpath(
      { ...graph, vertexIds: [...graph.vertexIds, v('goal')] },
      v('goal'),
      new Set([v('a'), v('b')]),
    );

    expect(path).not.toBeNull();
    // 2 (E1) + 3 (E2) + 1 (E3) — a pairwise Dijkstra would report 4.
    expect(path?.totalCost).toBe(6);
    expect(path?.steps.map((step) => step.edgeId)).toEqual([e('E1'), e('E2'), e('E3')]);
  });

  it('prefers the cheaper of two alternative supports', () => {
    const graph: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('t')],
      hyperedges: [
        { edgeId: e('cheap'), sourceVertexIds: [v('a')], targetVertexIds: [v('t')], cost: 1 },
        { edgeId: e('pricey'), sourceVertexIds: [v('a')], targetVertexIds: [v('t')], cost: 9 },
      ],
    };
    const path = minimalHyperpath(graph, v('t'), new Set([v('a')]));
    expect(path?.totalCost).toBe(1);
    expect(path?.steps.map((step) => step.edgeId)).toEqual([e('cheap')]);
  });

  it('returns null when the target has no support', () => {
    expect(minimalHyperpath(multiPremiseGraph, v('c'), new Set([v('a')]))).toBeNull();
  });
});

describe('topologicalSort', () => {
  it('is deterministic regardless of hyperedge insertion order', () => {
    const forward: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b'), v('c')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('b')], cost: 1 },
        { edgeId: e('E2'), sourceVertexIds: [v('b')], targetVertexIds: [v('c')], cost: 1 },
      ],
    };
    const reversed: DirectedIncidenceGraph = {
      vertexIds: [v('c'), v('b'), v('a')],
      hyperedges: [...forward.hyperedges].reverse(),
    };

    const a = topologicalSort(forward);
    const b = topologicalSort(reversed);
    expect(a).not.toBeNull();
    expect(a?.map((element) => `${element.kind}:${element.id}`)).toEqual(
      b?.map((element) => `${element.kind}:${element.id}`),
    );
  });

  it('returns null on a cyclic graph', () => {
    const cyclic: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('b')], cost: 1 },
        { edgeId: e('E2'), sourceVertexIds: [v('b')], targetVertexIds: [v('a')], cost: 1 },
      ],
    };
    expect(topologicalSort(cyclic)).toBeNull();
  });
});

describe('cycle detection and invariants', () => {
  it('rejects completing an edge whose target already reaches a source', () => {
    const completed: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('b')], cost: 1 },
      ],
    };
    const result = checkCycleOnComplete(completed, [v('b')], [v('a')]);
    expect(result.hasCycle).toBe(true);
    expect(result.offendingSourceIds).toEqual([v('b')]);
  });

  it('allows a completion that keeps the graph acyclic', () => {
    const completed: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b'), v('c')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('b')], cost: 1 },
      ],
    };
    expect(checkCycleOnComplete(completed, [v('b')], v('c')).hasCycle).toBe(false);
  });

  it('rejects when any one of several targets closes a loop', () => {
    const completed: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('b'), v('c')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('b')], cost: 1 },
      ],
    };
    // c alone would be harmless, but a is reachable from b, so the pair is rejected.
    expect(checkCycleOnComplete(completed, [v('b')], [v('c'), v('a')]).hasCycle).toBe(true);
  });

  it('derives every conclusion of a multi-target hyperedge', () => {
    const graph: DirectedIncidenceGraph = {
      vertexIds: [v('a'), v('x'), v('y')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('x'), v('y')], cost: 1 },
      ],
    };
    const base = new Set([v('a')]);
    expect(isSupported(graph, v('x'), base)).toBe(true);
    expect(isSupported(graph, v('y'), base)).toBe(true);
  });

  it('flags a self-loop as a structural violation', () => {
    const violations = validateGraphInvariants({
      vertexIds: [v('a')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('a')], cost: 1 },
      ],
    });
    expect(violations.some((violation) => violation.kind === 'SelfLoop')).toBe(true);
  });

  it('flags a cyclic strongly connected component', () => {
    const violations = validateGraphInvariants({
      vertexIds: [v('a'), v('b')],
      hyperedges: [
        { edgeId: e('E1'), sourceVertexIds: [v('a')], targetVertexIds: [v('b')], cost: 1 },
        { edgeId: e('E2'), sourceVertexIds: [v('b')], targetVertexIds: [v('a')], cost: 1 },
      ],
    });
    expect(violations.some((violation) => violation.kind === 'CyclicComponent')).toBe(true);
  });

  it('reports no violation on an acyclic completed graph', () => {
    expect(
      validateGraphInvariants({
        vertexIds: [v('a'), v('b'), v('c')],
        hyperedges: [
          { edgeId: e('E1'), sourceVertexIds: [v('a'), v('b')], targetVertexIds: [v('c')], cost: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it('finds only singleton components in a DAG', () => {
    const components = stronglyConnectedComponents(multiPremiseGraph);
    expect(components.every((component) => component.elements.length === 1)).toBe(true);
  });
});

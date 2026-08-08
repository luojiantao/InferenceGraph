import type { EdgeId, VertexId } from '@reasoner/schema';

/**
 * Directed incidence (bipartite) representation of the labelled hypergraph.
 *
 * A hyperedge with sources {a,b} and target c is stored as incidence arcs
 * a->E, b->E, E->c. Every algorithm below walks these arcs; none of them
 * collapses a hyperedge into pairwise vertex edges.
 */
export interface GraphArc {
  readonly from: GraphElement;
  readonly to: GraphElement;
}

export type GraphElement =
  | { readonly kind: 'vertex'; readonly id: VertexId }
  | { readonly kind: 'edge'; readonly id: EdgeId };

export interface HyperedgeView {
  readonly edgeId: EdgeId;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
  readonly cost: number;
}

export interface DirectedIncidenceGraph {
  readonly vertexIds: readonly VertexId[];
  readonly hyperedges: readonly HyperedgeView[];
}

export const elementKey = (element: GraphElement): string =>
  element.kind === 'vertex' ? `v:${element.id}` : `e:${element.id}`;

interface Adjacency {
  /** element key -> successor element keys, each list sorted for determinism. */
  readonly successors: ReadonlyMap<string, readonly string[]>;
  readonly allKeys: readonly string[];
}

const buildAdjacency = (graph: DirectedIncidenceGraph): Adjacency => {
  const successors = new Map<string, string[]>();
  const ensure = (key: string): string[] => {
    const existing = successors.get(key);
    if (existing !== undefined) return existing;
    const created: string[] = [];
    successors.set(key, created);
    return created;
  };

  for (const vertexId of graph.vertexIds) ensure(`v:${vertexId}`);

  for (const edge of graph.hyperedges) {
    const edgeKey = `e:${edge.edgeId}`;
    ensure(edgeKey);
    for (const sourceId of edge.sourceVertexIds) {
      ensure(`v:${sourceId}`).push(edgeKey);
    }
    for (const targetId of edge.targetVertexIds) {
      ensure(`v:${targetId}`);
      ensure(edgeKey).push(`v:${targetId}`);
    }
  }

  for (const list of successors.values()) list.sort();
  const allKeys = [...successors.keys()].sort();
  return { successors, allKeys };
};

const successorsOf = (adjacency: Adjacency, key: string): readonly string[] =>
  adjacency.successors.get(key) ?? [];

/**
 * STRUCTURAL (OR) reachability.
 *
 * Any single incidence arc makes the successor reachable. This is the semantics
 * used for cycle detection and structural diagnostics — NOT for deciding whether
 * a conclusion is actually supported. Do not substitute this for isSupported.
 */
export const isReachable = (
  graph: DirectedIncidenceGraph,
  from: VertexId,
  to: VertexId,
): boolean => {
  if (from === to) return true;
  const adjacency = buildAdjacency(graph);
  const targetKey = `v:${to}`;
  const seen = new Set<string>([`v:${from}`]);
  const stack: string[] = [`v:${from}`];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const next of successorsOf(adjacency, current)) {
      if (next === targetKey) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
};

/**
 * STRUCTURAL (OR) topological order over the bipartite incidence graph.
 *
 * Kahn's algorithm with a min-heap keyed by element key, so the order is stable
 * across runs and independent of insertion order. Returns null when the graph
 * contains a directed cycle.
 */
export const topologicalSort = (
  graph: DirectedIncidenceGraph,
): readonly GraphElement[] | null => {
  const adjacency = buildAdjacency(graph);
  const inDegree = new Map<string, number>();
  for (const key of adjacency.allKeys) inDegree.set(key, 0);
  for (const key of adjacency.allKeys) {
    for (const next of successorsOf(adjacency, key)) {
      inDegree.set(next, (inDegree.get(next) ?? 0) + 1);
    }
  }

  const heap = new MinHeap();
  for (const key of adjacency.allKeys) {
    if ((inDegree.get(key) ?? 0) === 0) heap.push(key);
  }

  const order: GraphElement[] = [];
  while (!heap.isEmpty()) {
    const current = heap.pop();
    if (current === undefined) break;
    order.push(parseKey(current));
    for (const next of successorsOf(adjacency, current)) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) heap.push(next);
    }
  }

  return order.length === adjacency.allKeys.length ? order : null;
};

const parseKey = (key: string): GraphElement => {
  const id = key.slice(2);
  return key.startsWith('v:')
    ? { kind: 'vertex', id: id as VertexId }
    : { kind: 'edge', id: id as EdgeId };
};

/** Binary min-heap of string keys; keeps topological order deterministic. */
class MinHeap {
  private readonly items: string[] = [];

  push(value: string): void {
    this.items.push(value);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = this.items[index];
      const above = this.items[parent];
      if (current === undefined || above === undefined || above <= current) break;
      this.items[parent] = current;
      this.items[index] = above;
      index = parent;
    }
  }

  pop(): string | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.siftDown();
    }
    return top;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  private siftDown(): void {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const atSmallest = this.items[smallest];
      const atLeft = this.items[left];
      const atRight = this.items[right];
      if (atLeft !== undefined && atSmallest !== undefined && atLeft < atSmallest) {
        smallest = left;
      }
      const atNewSmallest = this.items[smallest];
      if (atRight !== undefined && atNewSmallest !== undefined && atRight < atNewSmallest) {
        smallest = right;
      }
      if (smallest === index) return;
      const a = this.items[index];
      const b = this.items[smallest];
      if (a === undefined || b === undefined) return;
      this.items[index] = b;
      this.items[smallest] = a;
      index = smallest;
    }
  }
}

export interface StronglyConnectedComponent {
  readonly elements: readonly GraphElement[];
}

/**
 * STRUCTURAL (OR) strongly connected components, iterative Tarjan.
 *
 * Used by the invariant validator: any component of size > 1, or a self-arc,
 * means the completed subgraph is no longer a DAG.
 */
export const stronglyConnectedComponents = (
  graph: DirectedIncidenceGraph,
): readonly StronglyConnectedComponent[] => {
  const adjacency = buildAdjacency(graph);
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: StronglyConnectedComponent[] = [];
  let counter = 0;

  for (const root of adjacency.allKeys) {
    if (index.has(root)) continue;

    const work: Array<{ key: string; cursor: number }> = [{ key: root, cursor: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const next = successorsOf(adjacency, frame.key);

      if (frame.cursor < next.length) {
        const child = next[frame.cursor];
        frame.cursor += 1;
        if (child === undefined) continue;
        if (!index.has(child)) {
          index.set(child, counter);
          lowLink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ key: child, cursor: 0 });
        } else if (onStack.has(child)) {
          const childIndex = index.get(child) ?? 0;
          lowLink.set(frame.key, Math.min(lowLink.get(frame.key) ?? 0, childIndex));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowLink.set(
          parent.key,
          Math.min(lowLink.get(parent.key) ?? 0, lowLink.get(frame.key) ?? 0),
        );
      }

      if ((lowLink.get(frame.key) ?? 0) === (index.get(frame.key) ?? 0)) {
        const elements: GraphElement[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          elements.push(parseKey(member));
          if (member === frame.key) break;
        }
        components.push({ elements });
      }
    }
  }

  return components;
};

/** True when a hyperedge lists any of its own targets as a premise. */
export const hasSelfLoop = (graph: DirectedIncidenceGraph): boolean =>
  graph.hyperedges.some((edge) =>
    edge.targetVertexIds.some((targetId) => edge.sourceVertexIds.includes(targetId)),
  );

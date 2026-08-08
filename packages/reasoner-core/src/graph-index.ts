import type {
  EdgeId,
  GraphSnapshot,
  InferenceEdge,
  Vertex,
  VertexId,
} from '@reasoner/schema';
import type { DirectedIncidenceGraph, HyperedgeView } from './graph-theory.js';

/** Pre-computed adjacency over a snapshot; rebuilt per read, never cached across revisions. */
export interface GraphIndex {
  readonly snapshot: GraphSnapshot;
  readonly vertexById: ReadonlyMap<VertexId, Vertex>;
  readonly edgeById: ReadonlyMap<EdgeId, InferenceEdge>;
  /** Edges whose target is this vertex — i.e. the ways to derive it. */
  readonly incomingEdgeIds: ReadonlyMap<VertexId, readonly EdgeId[]>;
  /** Edges that consume this vertex as a premise. */
  readonly outgoingEdgeIds: ReadonlyMap<VertexId, readonly EdgeId[]>;
}

export const buildGraphIndex = (snapshot: GraphSnapshot): GraphIndex => {
  const vertexById = new Map<VertexId, Vertex>();
  const edgeById = new Map<EdgeId, InferenceEdge>();
  const incoming = new Map<VertexId, EdgeId[]>();
  const outgoing = new Map<VertexId, EdgeId[]>();

  for (const vertex of snapshot.vertices) {
    vertexById.set(vertex.vertexId, vertex);
    incoming.set(vertex.vertexId, []);
    outgoing.set(vertex.vertexId, []);
  }

  const push = (map: Map<VertexId, EdgeId[]>, key: VertexId, edgeId: EdgeId): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [edgeId]);
    else list.push(edgeId);
  };

  for (const edge of snapshot.edges) {
    edgeById.set(edge.edgeId, edge);
    for (const targetId of edge.targetVertexIds) push(incoming, targetId, edge.edgeId);
    for (const sourceId of edge.sourceVertexIds) push(outgoing, sourceId, edge.edgeId);
  }

  for (const list of incoming.values()) list.sort();
  for (const list of outgoing.values()) list.sort();

  return { snapshot, vertexById, edgeById, incomingEdgeIds: incoming, outgoingEdgeIds: outgoing };
};

const toHyperedgeView = (edge: InferenceEdge): HyperedgeView => ({
  edgeId: edge.edgeId,
  sourceVertexIds: edge.sourceVertexIds,
  targetVertexIds: edge.targetVertexIds,
  cost: edge.cost,
});

/** Incidence view over every edge, whatever its state. Used for structural diagnostics. */
export const toIncidenceGraph = (index: GraphIndex): DirectedIncidenceGraph => ({
  vertexIds: index.snapshot.vertices.map((vertex) => vertex.vertexId),
  hyperedges: index.snapshot.edges.map(toHyperedgeView),
});

/**
 * Incidence view restricted to Completed edges. This is the graph that must stay
 * a DAG, so cycle checks and invariant validation both run against it.
 */
export const toCompletedIncidenceGraph = (index: GraphIndex): DirectedIncidenceGraph => ({
  vertexIds: index.snapshot.vertices.map((vertex) => vertex.vertexId),
  hyperedges: index.snapshot.edges
    .filter((edge) => edge.state === 'Completed')
    .map(toHyperedgeView),
});

/** Vertices needing no derivation: Evidence, plus any vertex with no incoming edge. */
export const baseVertexIds = (index: GraphIndex): ReadonlySet<VertexId> => {
  const base = new Set<VertexId>();
  for (const vertex of index.snapshot.vertices) {
    const incoming = index.incomingEdgeIds.get(vertex.vertexId) ?? [];
    const derivable = incoming.some(
      (edgeId) => index.edgeById.get(edgeId)?.state === 'Completed',
    );
    if (vertex.kind === 'Evidence' || !derivable) base.add(vertex.vertexId);
  }
  return base;
};

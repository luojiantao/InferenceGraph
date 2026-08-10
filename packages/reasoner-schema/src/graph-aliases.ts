import type { EdgeId, VertexId } from './ids.js';

export interface AliasedVertex {
  readonly vertexId: VertexId;
  readonly referenceId: string;
  readonly createdAtRevision: number;
}

export interface AliasedEdge {
  readonly edgeId: EdgeId;
  readonly referenceId: string;
  readonly createdAtRevision: number;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
}

/** The graph shape needed to read persisted, session-local entity references. */
export interface AliasGraph {
  readonly vertices: readonly AliasedVertex[];
  readonly edges: readonly AliasedEdge[];
}

export interface GraphAliases {
  readonly vertexById: ReadonlyMap<VertexId, string>;
  readonly vertexIdByAlias: ReadonlyMap<string, VertexId>;
  /** One alias per persisted inference edge and its direct rendered arrow. */
  readonly edgeById: ReadonlyMap<EdgeId, string>;
  readonly edgeIdByAlias: ReadonlyMap<string, EdgeId>;
  /** Every rendered direct arrow points to its own edge alias. */
  readonly arcById: ReadonlyMap<string, string>;
}

const compareReferenceIds = (
  left: { readonly referenceId: string },
  right: { readonly referenceId: string },
): number => Number(left.referenceId.slice(1)) - Number(right.referenceId.slice(1));

export const buildArcId = (edgeId: EdgeId, sourceId: VertexId, targetId: VertexId): string =>
  `${edgeId}::${sourceId}::${targetId}`;

/** Reads the Vn/En references allocated and persisted when entities were created. */
export const buildGraphAliases = (graph: AliasGraph): GraphAliases => {
  const vertices = [...graph.vertices].sort(compareReferenceIds);
  const edges = [...graph.edges].sort(compareReferenceIds);

  const vertexById = new Map<VertexId, string>();
  const vertexIdByAlias = new Map<string, VertexId>();
  vertices.forEach((vertex) => {
    const alias = vertex.referenceId;
    vertexById.set(vertex.vertexId, alias);
    vertexIdByAlias.set(alias, vertex.vertexId);
  });

  const edgeById = new Map<EdgeId, string>();
  const edgeIdByAlias = new Map<string, EdgeId>();
  const arcById = new Map<string, string>();
  edges.forEach((edge) => {
    const alias = edge.referenceId;
    edgeById.set(edge.edgeId, alias);
    edgeIdByAlias.set(alias, edge.edgeId);

    for (const sourceId of edge.sourceVertexIds) {
      for (const targetId of edge.targetVertexIds) {
        arcById.set(buildArcId(edge.edgeId, sourceId, targetId), alias);
      }
    }
  });

  return {
    vertexById,
    vertexIdByAlias,
    edgeById,
    edgeIdByAlias,
    arcById,
  };
};

/** Resolves a public Vn reference while preserving a matching canonical id. */
export const resolveVertexReference = (aliases: GraphAliases, reference: VertexId): VertexId =>
  aliases.vertexById.has(reference)
    ? reference
    : (aliases.vertexIdByAlias.get(reference) ?? reference);

/** Resolves a public En reference while preserving a matching canonical id. */
export const resolveEdgeReference = (aliases: GraphAliases, reference: EdgeId): EdgeId =>
  aliases.edgeById.has(reference) ? reference : (aliases.edgeIdByAlias.get(reference) ?? reference);

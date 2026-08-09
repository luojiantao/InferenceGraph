import type { EdgeId, VertexId } from '@reasoner/schema';

interface AliasedVertex {
  readonly vertexId: VertexId;
  readonly createdAtRevision: number;
}

interface AliasedEdge {
  readonly edgeId: EdgeId;
  readonly createdAtRevision: number;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
}

interface AliasGraph {
  readonly vertices: readonly AliasedVertex[];
  readonly edges: readonly AliasedEdge[];
}

export interface GraphAliases {
  readonly vertexById: ReadonlyMap<VertexId, string>;
  readonly arcById: ReadonlyMap<string, string>;
  readonly edgeGroupById: ReadonlyMap<EdgeId, string>;
  readonly arcAliasesByEdgeId: ReadonlyMap<EdgeId, readonly string[]>;
}

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const buildArcId = (edgeId: EdgeId, sourceId: VertexId, targetId: VertexId): string =>
  `${edgeId}::${sourceId}::${targetId}`;

/** Assigns stable, session-wide aliases in graph creation order. */
export const buildGraphAliases = (graph: AliasGraph): GraphAliases => {
  const vertices = [...graph.vertices].sort(
    (left, right) =>
      left.createdAtRevision - right.createdAtRevision || compareIds(left.vertexId, right.vertexId),
  );
  const edges = [...graph.edges].sort(
    (left, right) =>
      left.createdAtRevision - right.createdAtRevision || compareIds(left.edgeId, right.edgeId),
  );

  const arcById = new Map<string, string>();
  const edgeGroupById = new Map<EdgeId, string>();
  const arcAliasesByEdgeId = new Map<EdgeId, readonly string[]>();
  let arcNumber = 1;

  for (const edge of edges) {
    const edgeAliases: string[] = [];
    for (const sourceId of edge.sourceVertexIds) {
      for (const targetId of edge.targetVertexIds) {
        const alias = `E${arcNumber}`;
        arcNumber += 1;
        edgeAliases.push(alias);
        arcById.set(buildArcId(edge.edgeId, sourceId, targetId), alias);
      }
    }
    arcAliasesByEdgeId.set(edge.edgeId, edgeAliases);
    edgeGroupById.set(edge.edgeId, edgeAliases.join('/'));
  }

  return {
    vertexById: new Map(vertices.map((vertex, index) => [vertex.vertexId, `V${index + 1}`])),
    arcById,
    edgeGroupById,
    arcAliasesByEdgeId,
  };
};

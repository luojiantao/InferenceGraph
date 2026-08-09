import type { EdgeId, VertexId } from '@reasoner/schema';
import { buildGraphAliases } from './graph-aliases.js';

interface FormulaVertex {
  readonly vertexId: VertexId;
  readonly createdAtRevision: number;
}

interface FormulaEdge {
  readonly edgeId: EdgeId;
  readonly createdAtRevision: number;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
}

interface FormulaGraph {
  readonly vertices: readonly FormulaVertex[];
  readonly edges: readonly FormulaEdge[];
}

export interface IncomingInferenceFormula {
  readonly edgeId: EdgeId;
  readonly expression: string;
}

/** Formats each incoming logical hyperedge once; premises within an edge are AND operands. */
export const buildIncomingInferenceFormulas = (
  graph: FormulaGraph,
  targetVertexId: VertexId,
): readonly IncomingInferenceFormula[] => {
  const aliases = buildGraphAliases(graph);
  const targetAlias = aliases.vertexById.get(targetVertexId) ?? targetVertexId;

  return graph.edges
    .filter((edge) => edge.targetVertexIds.includes(targetVertexId))
    .toSorted((left, right) => {
      const leftAlias = aliases.arcAliasesByEdgeId.get(left.edgeId)?.[0] ?? left.edgeId;
      const rightAlias = aliases.arcAliasesByEdgeId.get(right.edgeId)?.[0] ?? right.edgeId;
      return Number(leftAlias.slice(1)) - Number(rightAlias.slice(1));
    })
    .map((edge) => {
      const premises = edge.sourceVertexIds
        .map((sourceVertexId) => aliases.vertexById.get(sourceVertexId) ?? sourceVertexId)
        .join(' ∧ ');
      const edgeAliases = aliases.arcAliasesByEdgeId.get(edge.edgeId) ?? [edge.edgeId];

      return {
        edgeId: edge.edgeId,
        expression: `${edgeAliases.join(' ∧ ')}: ${premises} -> ${targetAlias}`,
      };
    });
};

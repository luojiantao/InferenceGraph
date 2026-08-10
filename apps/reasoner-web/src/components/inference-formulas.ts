import {
  buildInferenceFormulaGroups,
  type EdgeId,
  type EdgeState,
  type FormulaId,
  type VertexId,
} from '@reasoner/schema';
import { buildGraphAliases } from './graph-aliases.js';

interface FormulaVertex {
  readonly vertexId: VertexId;
  readonly referenceId: string;
  readonly createdAtRevision: number;
}

interface FormulaEdge {
  readonly edgeId: EdgeId;
  readonly formulaId: FormulaId;
  readonly referenceId: string;
  readonly createdAtRevision: number;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
  readonly state: EdgeState;
}

interface FormulaGraph {
  readonly vertices: readonly FormulaVertex[];
  readonly edges: readonly FormulaEdge[];
}

export interface IncomingInferenceFormula {
  readonly formulaId: FormulaId;
  readonly edgeIds: readonly EdgeId[];
  readonly expression: string;
  readonly completedEdgeCount: number;
  readonly requiredEdgeCount: number;
}

/** Formats formula groups: AND within a group, OR between groups for one target. */
export const buildIncomingInferenceFormulas = (
  graph: FormulaGraph,
  targetVertexId: VertexId,
): readonly IncomingInferenceFormula[] => {
  const aliases = buildGraphAliases(graph);
  const targetAlias = aliases.vertexById.get(targetVertexId) ?? targetVertexId;

  return buildInferenceFormulaGroups(graph.edges)
    .filter((formula) => formula.targetVertexId === targetVertexId)
    .toSorted((left, right) => {
      const leftEdgeId = left.edgeIds[0];
      const rightEdgeId = right.edgeIds[0];
      const leftAlias =
        leftEdgeId === undefined ? '' : (aliases.edgeById.get(leftEdgeId) ?? leftEdgeId);
      const rightAlias =
        rightEdgeId === undefined ? '' : (aliases.edgeById.get(rightEdgeId) ?? rightEdgeId);
      return Number(leftAlias.slice(1)) - Number(rightAlias.slice(1));
    })
    .map((formula) => {
      const edges = [...formula.edges].toSorted((left, right) => {
        const leftAlias = aliases.edgeById.get(left.edgeId) ?? left.edgeId;
        const rightAlias = aliases.edgeById.get(right.edgeId) ?? right.edgeId;
        return Number(leftAlias.slice(1)) - Number(rightAlias.slice(1));
      });
      const edgeAliases = edges.map((edge) => aliases.edgeById.get(edge.edgeId) ?? edge.edgeId);
      const premises = edges.map((edge) => {
        const sourceVertexId = edge.sourceVertexIds[0];
        return sourceVertexId === undefined
          ? '未知顶点'
          : (aliases.vertexById.get(sourceVertexId) ?? sourceVertexId);
      });

      return {
        formulaId: formula.formulaId,
        edgeIds: edges.map((edge) => edge.edgeId),
        expression: `${edgeAliases.join(' ∧ ')}: ${premises.join(' ∧ ')} -> ${targetAlias}`,
        completedEdgeCount: edges.filter((edge) => edge.state === 'Completed').length,
        requiredEdgeCount: edges.length,
      };
    });
};

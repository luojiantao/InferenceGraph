import type { EdgeId, FormulaId, VertexId } from './ids.js';

/** Minimum persisted edge shape needed to reconstruct a vertex formula. */
export interface FormulaComponent {
  readonly edgeId: EdgeId;
  readonly formulaId: FormulaId;
  readonly sourceVertexIds: readonly VertexId[];
  readonly targetVertexIds: readonly VertexId[];
}

/**
 * A formula has AND semantics between its direct physical edges. Formulae
 * targeting the same vertex are alternatives, so they have OR semantics.
 */
export interface InferenceFormulaGroup<TEdge extends FormulaComponent = FormulaComponent> {
  readonly formulaId: FormulaId;
  readonly targetVertexId: VertexId;
  readonly edgeIds: readonly EdgeId[];
  readonly sourceVertexIds: readonly VertexId[];
  readonly edges: readonly TEdge[];
}

/** Reconstructs formula groups without introducing a graph vertex for a formula. */
export const buildInferenceFormulaGroups = <TEdge extends FormulaComponent>(
  edges: readonly TEdge[],
): readonly InferenceFormulaGroup<TEdge>[] => {
  const groups = new Map<
    string,
    {
      formulaId: FormulaId;
      targetVertexId: VertexId;
      edges: TEdge[];
      sourceVertexIds: Set<VertexId>;
    }
  >();

  for (const edge of edges) {
    for (const targetVertexId of edge.targetVertexIds) {
      const key = `${edge.formulaId}\u0000${targetVertexId}`;
      const group = groups.get(key) ?? {
        formulaId: edge.formulaId,
        targetVertexId,
        edges: [],
        sourceVertexIds: new Set<VertexId>(),
      };
      group.edges.push(edge);
      for (const sourceVertexId of edge.sourceVertexIds) group.sourceVertexIds.add(sourceVertexId);
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      formulaId: group.formulaId,
      targetVertexId: group.targetVertexId,
      edgeIds: group.edges.map((edge) => edge.edgeId),
      sourceVertexIds: [...group.sourceVertexIds],
      edges: group.edges,
    }))
    .sort((left, right) =>
      left.formulaId === right.formulaId
        ? left.targetVertexId < right.targetVertexId
          ? -1
          : 1
        : left.formulaId < right.formulaId
          ? -1
          : 1,
    );
};

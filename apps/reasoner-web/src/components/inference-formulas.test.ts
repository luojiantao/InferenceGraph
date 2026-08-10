import type { EdgeId, FormulaId, VertexId } from '@reasoner/schema';
import { describe, expect, it } from 'vitest';
import { buildGraphAliases } from './graph-aliases.js';
import { buildIncomingInferenceFormulas } from './inference-formulas.js';

const vertexId = (value: string): VertexId => value as VertexId;
const edgeId = (value: string): EdgeId => value as EdgeId;
const formulaId = (value: string): FormulaId => value as FormulaId;

describe('buildIncomingInferenceFormulas', () => {
  it('keeps direct edge aliases while restoring conjunction in a formula group', () => {
    const target = vertexId('target');
    const graph = {
      vertices: [
        { vertexId: target, referenceId: 'V4', createdAtRevision: 4 },
        { vertexId: vertexId('c'), referenceId: 'V3', createdAtRevision: 3 },
        { vertexId: vertexId('a'), referenceId: 'V1', createdAtRevision: 1 },
        { vertexId: vertexId('b'), referenceId: 'V2', createdAtRevision: 2 },
      ],
      edges: [
        {
          edgeId: edgeId('edge-2'),
          formulaId: formulaId('formula-target'),
          referenceId: 'E3',
          createdAtRevision: 3,
          sourceVertexIds: [vertexId('c')],
          targetVertexIds: [target],
          state: 'Completed' as const,
        },
        {
          edgeId: edgeId('edge-1'),
          formulaId: formulaId('formula-target'),
          referenceId: 'E2',
          createdAtRevision: 2,
          sourceVertexIds: [vertexId('a')],
          targetVertexIds: [target],
          state: 'Candidate' as const,
        },
        {
          edgeId: edgeId('outgoing'),
          formulaId: formulaId('formula-outgoing'),
          referenceId: 'E1',
          createdAtRevision: 1,
          sourceVertexIds: [target],
          targetVertexIds: [vertexId('c')],
          state: 'Completed' as const,
        },
      ],
    };

    const aliases = buildGraphAliases(graph);
    expect([...aliases.vertexById.entries()]).toEqual([
      [vertexId('a'), 'V1'],
      [vertexId('b'), 'V2'],
      [vertexId('c'), 'V3'],
      [target, 'V4'],
    ]);
    expect(aliases.vertexIdByAlias.get('V1')).toBe(vertexId('a'));
    expect([...aliases.edgeById.entries()]).toEqual([
      [edgeId('outgoing'), 'E1'],
      [edgeId('edge-1'), 'E2'],
      [edgeId('edge-2'), 'E3'],
    ]);
    expect(aliases.edgeIdByAlias.get('E2')).toBe(edgeId('edge-1'));
    expect([...aliases.arcById.values()]).toEqual(['E1', 'E2', 'E3']);
    expect(buildIncomingInferenceFormulas(graph, target)).toEqual([
      {
        formulaId: formulaId('formula-target'),
        edgeIds: [edgeId('edge-1'), edgeId('edge-2')],
        expression: 'E2 ∧ E3: V1 ∧ V3 -> V4',
        completedEdgeCount: 1,
        requiredEdgeCount: 2,
      },
    ]);
  });
});

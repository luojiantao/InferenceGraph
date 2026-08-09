import type { EdgeId, VertexId } from '@reasoner/schema';
import { describe, expect, it } from 'vitest';
import { buildGraphAliases } from './graph-aliases.js';
import { buildIncomingInferenceFormulas } from './inference-formulas.js';

const vertexId = (value: string): VertexId => value as VertexId;
const edgeId = (value: string): EdgeId => value as EdgeId;

describe('buildIncomingInferenceFormulas', () => {
  it('uses stable global aliases and groups premises with AND', () => {
    const target = vertexId('target');
    const graph = {
      vertices: [
        { vertexId: target, createdAtRevision: 4 },
        { vertexId: vertexId('c'), createdAtRevision: 3 },
        { vertexId: vertexId('a'), createdAtRevision: 1 },
        { vertexId: vertexId('b'), createdAtRevision: 2 },
      ],
      edges: [
        {
          edgeId: edgeId('edge-2'),
          createdAtRevision: 3,
          sourceVertexIds: [vertexId('c')],
          targetVertexIds: [target],
        },
        {
          edgeId: edgeId('edge-1'),
          createdAtRevision: 2,
          sourceVertexIds: [vertexId('a'), vertexId('b')],
          targetVertexIds: [target],
        },
        {
          edgeId: edgeId('outgoing'),
          createdAtRevision: 1,
          sourceVertexIds: [target],
          targetVertexIds: [vertexId('c')],
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
    expect([...aliases.edgeGroupById.entries()]).toEqual([
      [edgeId('outgoing'), 'E1'],
      [edgeId('edge-1'), 'E2/E3'],
      [edgeId('edge-2'), 'E4'],
    ]);
    expect(buildIncomingInferenceFormulas(graph, target)).toEqual([
      { edgeId: edgeId('edge-1'), expression: 'E2 ∧ E3: V1 ∧ V2 -> V4' },
      { edgeId: edgeId('edge-2'), expression: 'E4: V3 -> V4' },
    ]);
  });
});

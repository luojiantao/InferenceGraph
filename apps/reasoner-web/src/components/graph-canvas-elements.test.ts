import type { ElementDefinition } from 'cytoscape';
import type { EdgeId, GraphSnapshot, VertexId } from '@reasoner/schema';
import { describe, expect, it } from 'vitest';
import { buildArcId } from './graph-aliases.js';
import { buildExpansionStatusNodeId, buildGraphCanvasElements } from './graph-canvas-elements.js';

const vertexId = (value: string): VertexId => value as VertexId;
const edgeId = (value: string): EdgeId => value as EdgeId;
const dataOf = (element: ElementDefinition): Record<string, unknown> =>
  element.data as Record<string, unknown>;

describe('buildGraphCanvasElements', () => {
  it('gives an actively expanding vertex a dedicated graph state and class', () => {
    const expanding = vertexId('expanding');
    const pending = vertexId('pending');
    const snapshot = {
      session: { goalVertexId: pending },
      vertices: [
        {
          vertexId: expanding,
          referenceId: 'V1',
          kind: 'State',
          label: 'Collect machine logs',
          createdAtRevision: 1,
        },
        {
          vertexId: pending,
          referenceId: 'V2',
          kind: 'Goal',
          label: 'Find the root cause',
          createdAtRevision: 1,
        },
      ],
      edges: [],
      vertexExpansions: [
        { vertexId: expanding, state: 'Expanding' },
        { vertexId: pending, state: 'Pending' },
      ],
    } as unknown as GraphSnapshot;

    const elements = buildGraphCanvasElements(snapshot, [], null, 'All');
    const expandingNode = elements.find((element) => dataOf(element).id === expanding);
    const pendingNode = elements.find((element) => dataOf(element).id === pending);
    const expandingStatusNode = elements.find(
      (element) => dataOf(element).id === buildExpansionStatusNodeId(expanding),
    );

    expect(dataOf(expandingNode!)).toMatchObject({
      expansionState: 'Expanding',
      expansionLabel: '⟳ 展开中',
      label: 'V1: Collect machine logs',
    });
    expect(String(expandingNode!.classes)).toContain('expansion-Expanding has-expansion-status');
    expect(dataOf(expandingStatusNode!)).toMatchObject({
      vertexId: expanding,
      label: '⟳ 展开中',
      expansionState: 'Expanding',
    });
    expect(String(expandingStatusNode!.classes)).toContain('expansion-status-Expanding');
    expect(dataOf(pendingNode!)).toMatchObject({
      expansionState: 'Pending',
      expansionLabel: '○ 待展开',
      label: 'V2: Find the root cause',
    });
  });

  it('renders every independent inference edge as one direct labelled arrow', () => {
    const firstEdge = edgeId('first-edge');
    const secondEdge = edgeId('second-edge');
    const thirdEdge = edgeId('third-edge');
    const target = vertexId('target');
    const snapshot = {
      session: { goalVertexId: target },
      vertices: [
        {
          vertexId: vertexId('a'),
          referenceId: 'V1',
          kind: 'State',
          label: 'A',
          createdAtRevision: 1,
        },
        {
          vertexId: vertexId('b'),
          referenceId: 'V3',
          kind: 'Evidence',
          label: 'B',
          createdAtRevision: 2,
        },
        {
          vertexId: vertexId('c'),
          referenceId: 'V4',
          kind: 'State',
          label: 'C',
          createdAtRevision: 3,
        },
        {
          vertexId: target,
          referenceId: 'V9',
          kind: 'Goal',
          label: 'Goal',
          createdAtRevision: 4,
        },
      ],
      edges: [
        {
          edgeId: firstEdge,
          referenceId: 'E1',
          sourceVertexIds: [vertexId('a')],
          targetVertexIds: [target],
          state: 'Completed',
          createdAtRevision: 1,
        },
        {
          edgeId: secondEdge,
          referenceId: 'E2',
          sourceVertexIds: [vertexId('b')],
          targetVertexIds: [target],
          state: 'Candidate',
          createdAtRevision: 2,
        },
        {
          edgeId: thirdEdge,
          referenceId: 'E3',
          sourceVertexIds: [vertexId('c')],
          targetVertexIds: [target],
          state: 'Completed',
          createdAtRevision: 3,
        },
      ],
    } as unknown as GraphSnapshot;

    const elements = buildGraphCanvasElements(snapshot, [], null, 'All');
    const arrows = elements.filter((element) => String(element.classes).includes('inference-edge'));

    expect(arrows.map(dataOf)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: buildArcId(firstEdge, vertexId('a'), target),
          source: vertexId('a'),
          target,
          inferenceEdgeId: firstEdge,
          label: 'E1',
        }),
        expect.objectContaining({
          id: buildArcId(secondEdge, vertexId('b'), target),
          source: vertexId('b'),
          target,
          inferenceEdgeId: secondEdge,
          label: 'E2',
        }),
        expect.objectContaining({
          id: buildArcId(thirdEdge, vertexId('c'), target),
          source: vertexId('c'),
          target,
          inferenceEdgeId: thirdEdge,
          label: 'E3',
        }),
      ]),
    );
    expect(arrows).toHaveLength(3);
    expect(
      elements.some((element) => String(dataOf(element).id).startsWith('inference-edge::')),
    ).toBe(false);
  });
});

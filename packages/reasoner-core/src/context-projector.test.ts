import type {
  EdgeId,
  EdgeReferenceId,
  FormulaId,
  GraphSnapshot,
  InferenceEdge,
  Vertex,
  VertexId,
  VertexReferenceId,
} from '@reasoner/schema';
import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from './graph-index.js';
import { collectAncestors, projectVertexContext } from './context-projector.js';

const vertexId = (value: string): VertexId => value as VertexId;

const vertex = (id: string, referenceId: string, kind: Vertex['kind']): Vertex =>
  ({
    vertexId: vertexId(id),
    referenceId: referenceId as VertexReferenceId,
    kind,
    label: referenceId,
    payload: {},
    createdByAgentId: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdAtRevision: 1,
  }) as Vertex;

const candidateEdge = (sourceVertexId: VertexId, targetVertexId: VertexId): InferenceEdge =>
  ({
    edgeId: 'edge-1' as EdgeId,
    referenceId: 'E1' as EdgeReferenceId,
    formulaId: 'formula-1' as FormulaId,
    sourceVertexIds: [sourceVertexId],
    targetVertexIds: [targetVertexId],
    label: 'candidate relation',
    state: 'Candidate',
    cost: 1,
    priority: 0,
    evidenceQuestions: [],
    proposedByAgentId: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdAtRevision: 1,
    updatedAtRevision: 1,
  }) as InferenceEdge;

describe('vertex dependency projection', () => {
  it('shows candidate formula branches without treating them as completed execution ancestors', () => {
    const goal = vertex('goal', 'V1', 'Goal');
    const premise = vertex('premise', 'V2', 'State');
    const edge = candidateEdge(premise.vertexId, goal.vertexId);
    const snapshot = {
      session: {
        sessionId: 'projection-test',
        goalVertexId: goal.vertexId,
        goalState: 'Verifying',
        strategy: 'BFS',
        projectionPolicy: 'DependencySubgraph',
        budget: { maxEdges: 10, maxDepth: 5, maxLeaseSeconds: 60 },
        graphRevision: 1,
        lastEventSeq: 0,
        createdByAgentId: 'agent',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      vertices: [goal, premise],
      edges: [edge],
      graphRevision: 1,
      snapshotHash: '0'.repeat(64),
    } as GraphSnapshot;

    const vertexContext = projectVertexContext(snapshot, goal.vertexId, 'DependencySubgraph');
    expect(vertexContext.ok).toBe(true);
    if (vertexContext.ok) {
      expect(vertexContext.value.ancestorEdges.map((item) => item.edgeId)).toEqual([edge.edgeId]);
      expect(vertexContext.value.ancestorVertices.map((item) => item.vertexId)).toEqual([
        premise.vertexId,
      ]);
    }

    expect(collectAncestors(buildGraphIndex(snapshot), goal.vertexId, 5).edges).toEqual([]);
  });
});

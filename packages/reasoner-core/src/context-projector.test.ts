import type {
  EdgeId,
  EdgeReferenceId,
  EdgeState,
  FormulaId,
  GraphSnapshot,
  InferenceEdge,
  Vertex,
  VertexId,
  VertexReferenceId,
} from '@reasoner/schema';
import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from './graph-index.js';
import {
  collectAncestors,
  projectVertexContext,
  projectVertexDownstreamContext,
} from './context-projector.js';

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

const edge = (
  id: string,
  referenceId: string,
  sourceVertexId: VertexId,
  targetVertexId: VertexId,
  state: EdgeState = 'Candidate',
): InferenceEdge =>
  ({
    ...candidateEdge(sourceVertexId, targetVertexId),
    edgeId: id as EdgeId,
    referenceId: referenceId as EdgeReferenceId,
    formulaId: `formula-${id}` as FormulaId,
    label: `${referenceId} relation`,
    state,
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

describe('vertex downstream projection', () => {
  it('returns every direct consumer and one shortest retained route to the Goal', () => {
    const goal = vertex('goal', 'V1', 'Goal');
    const current = vertex('current', 'V2', 'State');
    const middle = vertex('middle', 'V3', 'State');
    const candidate = edge('edge-1', 'E1', current.vertexId, middle.vertexId);
    const completed = edge('edge-2', 'E2', middle.vertexId, goal.vertexId, 'Completed');
    const abandoned = edge('edge-3', 'E3', current.vertexId, goal.vertexId, 'Abandoned');
    const invalid = edge('edge-4', 'E4', current.vertexId, goal.vertexId, 'Invalid');
    const snapshot = {
      session: {
        sessionId: 'downstream-test',
        goalVertexId: goal.vertexId,
        goalState: 'Verifying',
        strategy: 'BFS',
        projectionPolicy: 'DependencySubgraph',
        budget: { maxEdges: 10, maxDepth: 5, maxLeaseSeconds: 60 },
        graphRevision: 4,
        lastEventSeq: 0,
        createdByAgentId: 'agent',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      vertices: [goal, current, middle],
      edges: [candidate, completed, abandoned, invalid],
      graphRevision: 4,
      snapshotHash: '0'.repeat(64),
    } as GraphSnapshot;

    const result = projectVertexDownstreamContext(snapshot, current.vertexId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.directDownstreamEdges.map((item) => item.edgeId)).toEqual([
      candidate.edgeId,
      abandoned.edgeId,
      invalid.edgeId,
    ]);
    expect(result.value.directDownstreamVertices.map((item) => item.vertexId)).toEqual([
      goal.vertexId,
      middle.vertexId,
    ]);
    expect(result.value.goalPathSummary).toMatchObject({ reachable: true, hopCount: 2 });
    expect(result.value.goalPathSummary.vertices.map((item) => item.vertexId)).toEqual([
      current.vertexId,
      middle.vertexId,
      goal.vertexId,
    ]);
    expect(result.value.goalPathSummary.edges.map((item) => item.edgeId)).toEqual([
      candidate.edgeId,
      completed.edgeId,
    ]);
  });

  it('returns a zero-hop path when the current vertex is the Goal', () => {
    const goal = vertex('goal', 'V1', 'Goal');
    const snapshot = {
      session: {
        sessionId: 'goal-downstream-test',
        goalVertexId: goal.vertexId,
        goalState: 'Exploring',
        strategy: 'DFS',
        projectionPolicy: 'CurrentOnly',
        budget: { maxEdges: 10, maxDepth: 5, maxLeaseSeconds: 60 },
        graphRevision: 1,
        lastEventSeq: 0,
        createdByAgentId: 'agent',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      vertices: [goal],
      edges: [],
      graphRevision: 1,
      snapshotHash: '0'.repeat(64),
    } as GraphSnapshot;

    const result = projectVertexDownstreamContext(snapshot, goal.vertexId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.goalPathSummary).toEqual({
      reachable: true,
      hopCount: 0,
      vertices: [goal],
      edges: [],
    });
  });
});

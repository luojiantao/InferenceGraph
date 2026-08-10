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
import { assessGoal } from './goal-evaluator.js';

const vertexId = (value: string): VertexId => value as VertexId;
const formulaId = (value: string): FormulaId => value as FormulaId;

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

const edge = (
  id: string,
  referenceId: string,
  groupId: FormulaId,
  sourceId: VertexId,
  targetId: VertexId,
  state: InferenceEdge['state'],
): InferenceEdge =>
  ({
    edgeId: id as EdgeId,
    referenceId: referenceId as EdgeReferenceId,
    formulaId: groupId,
    sourceVertexIds: [sourceId],
    targetVertexIds: [targetId],
    label: 'relation',
    state,
    cost: 1,
    priority: 0,
    evidenceQuestions: [],
    proposedByAgentId: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdAtRevision: 1,
    updatedAtRevision: 1,
  }) as InferenceEdge;

const snapshot = (edges: readonly InferenceEdge[]): GraphSnapshot => {
  const premiseA = vertex('a', 'V1', 'State');
  const premiseB = vertex('b', 'V2', 'State');
  const goal = vertex('goal', 'V3', 'Goal');
  return {
    session: {
      sessionId: 'formula-semantics',
      goalVertexId: goal.vertexId,
      goalState: 'Exploring',
      strategy: 'BFS',
      projectionPolicy: 'DependencySubgraph',
      budget: { maxEdges: 100, maxDepth: 10, maxLeaseSeconds: 60 },
      graphRevision: 1,
      lastEventSeq: 0,
      createdByAgentId: 'agent',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    vertices: [premiseA, premiseB, goal],
    edges: [...edges],
    graphRevision: 1,
    snapshotHash: '0'.repeat(64),
  } as GraphSnapshot;
};

describe('independent edges with vertex formulas', () => {
  it('does not derive a target until every edge in its AND formula is completed', () => {
    const target = vertexId('goal');
    const group = formulaId('formula-all');
    const partial = snapshot([
      edge('e1', 'E1', group, vertexId('a'), target, 'Completed'),
      edge('e2', 'E2', group, vertexId('b'), target, 'Candidate'),
    ]);
    const complete = snapshot([
      edge('e1', 'E1', group, vertexId('a'), target, 'Completed'),
      edge('e2', 'E2', group, vertexId('b'), target, 'Completed'),
    ]);

    expect(assessGoal(partial).goalSupported).toBe(false);
    expect(assessGoal(complete).goalSupported).toBe(true);
  });

  it('allows a separate completed formula as an alternative derivation', () => {
    const target = vertexId('goal');
    const allRequired = formulaId('formula-all');
    const alternative = formulaId('formula-alternative');
    const graph = snapshot([
      edge('e1', 'E1', allRequired, vertexId('a'), target, 'Completed'),
      edge('e2', 'E2', allRequired, vertexId('b'), target, 'Candidate'),
      edge('e3', 'E3', alternative, vertexId('a'), target, 'Completed'),
    ]);

    expect(assessGoal(graph).goalSupported).toBe(true);
  });
});

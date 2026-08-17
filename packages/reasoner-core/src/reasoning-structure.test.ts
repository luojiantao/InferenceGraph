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
import { buildReasoningStructure } from './reasoning-structure.js';

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

describe('buildReasoningStructure', () => {
  it('materializes compact AND/OR formula groups and goal assessment', () => {
    const premiseA = vertex('a', 'V1', 'State');
    const premiseB = vertex('b', 'V2', 'State');
    const premiseC = vertex('c', 'V3', 'State');
    const intermediate = vertex('intermediate', 'V4', 'State');
    const goal = vertex('goal', 'V5', 'Goal');
    const allFirst = edge(
      'e1',
      'E1',
      formulaId('formula-all'),
      premiseA.vertexId,
      goal.vertexId,
      'Completed',
    );
    const allSecond = edge(
      'e2',
      'E2',
      formulaId('formula-all'),
      premiseB.vertexId,
      goal.vertexId,
      'Candidate',
    );
    const alternative = edge(
      'e3',
      'E3',
      formulaId('formula-alternative'),
      premiseC.vertexId,
      goal.vertexId,
      'Completed',
    );
    const blocked = edge(
      'e4',
      'E4',
      formulaId('formula-blocked'),
      premiseA.vertexId,
      intermediate.vertexId,
      'Blocked',
    );
    const leased = edge(
      'e5',
      'E5',
      formulaId('formula-leased'),
      premiseB.vertexId,
      intermediate.vertexId,
      'Leased',
    );
    const snapshot: GraphSnapshot = {
      session: {
        sessionId: 'reasoning-structure',
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
      vertices: [premiseA, premiseB, premiseC, intermediate, goal],
      edges: [allFirst, allSecond, alternative, blocked, leased],
      graphRevision: 1,
      snapshotHash: '0'.repeat(64),
    } as GraphSnapshot;

    const structure = buildReasoningStructure(snapshot);
    const formulaById = new Map(
      structure.formulaGroups.map((formula) => [formula.formulaId, formula]),
    );

    expect(structure.schemaVersion).toBe(1);
    expect(formulaById.get(formulaId('formula-all'))).toEqual({
      formulaId: formulaId('formula-all'),
      sourceVertexIds: [premiseA.vertexId, premiseB.vertexId],
      targetVertexId: goal.vertexId,
      edgeIds: [allFirst.edgeId, allSecond.edgeId],
      state: 'Candidate',
    });
    expect(formulaById.get(formulaId('formula-alternative'))?.state).toBe('Completed');
    expect(formulaById.get(formulaId('formula-blocked'))?.state).toBe('Blocked');
    expect(formulaById.get(formulaId('formula-leased'))?.state).toBe('Leased');
    expect(structure.goalAssessment).toEqual({
      goalSupported: true,
      recommendedGoalState: 'CandidateFound',
      rationale: 'goal is supported but 2 edge(s) still require verification',
    });

    // This is an index over snapshot entities, not a second copy of the graph.
    expect(structure).not.toHaveProperty('vertices');
    expect(structure).not.toHaveProperty('edges');
    expect(structure.formulaGroups[0]).not.toHaveProperty('label');
  });
});

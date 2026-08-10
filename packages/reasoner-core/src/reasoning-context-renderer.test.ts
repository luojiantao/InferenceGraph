import type {
  EdgeId,
  EdgeReferenceId,
  FormulaId,
  InferenceEdge,
  Vertex,
  VertexExpansionContext,
  VertexId,
  VertexReferenceId,
} from '@reasoner/schema';
import { buildGraphAliases } from '@reasoner/schema';
import { describe, expect, it } from 'vitest';
import { renderVertexReasoningContext } from './reasoning-context-renderer.js';

const vertexId = (value: string): VertexId => value as VertexId;

const vertex = (id: string, referenceId: string, label: string, kind: Vertex['kind']): Vertex =>
  ({
    vertexId: vertexId(id),
    referenceId: referenceId as VertexReferenceId,
    kind,
    label,
    payload: {},
    createdByAgentId: 'agent-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdAtRevision: 1,
  }) as Vertex;

const edge = (id: string, referenceId: string, sourceId: string, targetId: string): InferenceEdge =>
  ({
    edgeId: id as EdgeId,
    referenceId: referenceId as EdgeReferenceId,
    formulaId: 'formula-target' as FormulaId,
    sourceVertexIds: [vertexId(sourceId)],
    targetVertexIds: [vertexId(targetId)],
    label: `${referenceId} relation`,
    state: 'Completed',
    cost: 1,
    priority: 0,
    evidenceQuestions: [],
    proposedByAgentId: 'agent-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdAtRevision: 1,
    updatedAtRevision: 1,
  }) as InferenceEdge;

describe('renderVertexReasoningContext', () => {
  it('uses one direct Mermaid arrow and one En label for every independent relation', () => {
    const v1 = vertex('source-1', 'V1', 'first premise', 'State');
    const v3 = vertex('source-3', 'V3', 'second premise', 'State');
    const v4 = vertex('source-4', 'V4', 'third premise', 'Evidence');
    const v9 = vertex('target', 'V9', 'current conclusion', 'Goal');
    const edges = [
      edge('edge-1', 'E1', v1.vertexId, v9.vertexId),
      edge('edge-2', 'E2', v3.vertexId, v9.vertexId),
      edge('edge-3', 'E3', v4.vertexId, v9.vertexId),
    ];
    const context = {
      sessionId: 'session-test',
      vertexId: v9.vertexId,
      policy: 'DependencySubgraph',
      graphRevision: 1,
      goalVertex: v9,
      currentVertex: v9,
      ancestorVertices: [v1, v3, v4],
      ancestorEdges: edges,
      evidenceDigests: [],
      expansionHandles: [],
      omittedVertexIds: [],
      omittedEdgeIds: [],
      contextHash: '0'.repeat(64),
    } as VertexExpansionContext;

    const rendered = renderVertexReasoningContext(
      context,
      buildGraphAliases({ vertices: [v1, v3, v4, v9], edges }),
    );

    expect(rendered.mermaid).toContain('  v1 -->|E1| v9');
    expect(rendered.mermaid).toContain('  v3 -->|E2| v9');
    expect(rendered.mermaid).toContain('  v4 -->|E3| v9');
    expect(rendered.mermaid).toContain(
      'v9["V9 · current conclusion<br/>公式：E1 ∧ E2 ∧ E3"]',
    );
    expect(rendered.mermaid).toContain('E1 ∧ E2 ∧ E3: V1 ∧ V3 ∧ V4 -> V9');
    expect(rendered.reasoningText).toContain('该公式内的全部条件都必须完成');
    expect(rendered.mermaid).not.toContain('{{');
  });
});

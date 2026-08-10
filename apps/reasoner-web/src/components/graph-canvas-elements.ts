import type { ElementDefinition } from 'cytoscape';
import type { EdgeId, GraphSnapshot, VertexId } from '@reasoner/schema';
import type { GraphScope } from '../state/graph-store.js';
import { buildArcId, buildGraphAliases } from './graph-aliases.js';

interface VisibleSubgraph {
  readonly vertexIds: ReadonlySet<VertexId>;
  readonly edgeIds: ReadonlySet<EdgeId>;
}

const fullGraph = (snapshot: GraphSnapshot): VisibleSubgraph => ({
  vertexIds: new Set(snapshot.vertices.map((vertex) => vertex.vertexId)),
  edgeIds: new Set(snapshot.edges.map((edge) => edge.edgeId)),
});

/** Builds the upstream dependency subgraph required to derive a selected vertex. */
const visibleSubgraph = (
  snapshot: GraphSnapshot,
  selectedVertexId: VertexId | null,
  scope: GraphScope,
): VisibleSubgraph => {
  if (scope === 'All' || selectedVertexId === null) return fullGraph(snapshot);
  if (scope === 'CurrentVertex') {
    return { vertexIds: new Set([selectedVertexId]), edgeIds: new Set() };
  }

  const vertexIds = new Set<VertexId>([selectedVertexId]);
  const edgeIds = new Set<EdgeId>();
  const visitedTargets = new Set<VertexId>();
  const pendingTargets: VertexId[] = [selectedVertexId];

  while (pendingTargets.length > 0) {
    const targetId = pendingTargets.pop();
    if (targetId === undefined || visitedTargets.has(targetId)) continue;
    visitedTargets.add(targetId);

    for (const edge of snapshot.edges) {
      if (!edge.targetVertexIds.includes(targetId)) continue;
      edgeIds.add(edge.edgeId);
      for (const vertexId of edge.targetVertexIds) vertexIds.add(vertexId);
      for (const vertexId of edge.sourceVertexIds) {
        vertexIds.add(vertexId);
        if (!visitedTargets.has(vertexId)) pendingTargets.push(vertexId);
      }
    }
  }

  return { vertexIds, edgeIds };
};

/** Projects each persisted inference edge as one labelled, direct arrow. */
export const buildGraphCanvasElements = (
  snapshot: GraphSnapshot,
  frontier: readonly EdgeId[],
  selectedVertexId: VertexId | null,
  scope: GraphScope,
): ElementDefinition[] => {
  const frontierSet = new Set<string>(frontier);
  const visible = visibleSubgraph(snapshot, selectedVertexId, scope);
  const aliases = buildGraphAliases(snapshot);
  const elements: ElementDefinition[] = [];

  for (const vertex of snapshot.vertices) {
    if (!visible.vertexIds.has(vertex.vertexId)) continue;
    const alias = aliases.vertexById.get(vertex.vertexId) ?? vertex.vertexId;
    elements.push({
      data: {
        id: vertex.vertexId,
        alias,
        label: `${alias}: ${vertex.label}`,
        kind: vertex.kind,
        isGoal: vertex.vertexId === snapshot.session.goalVertexId,
      },
      classes: `vertex kind-${vertex.kind}${
        vertex.vertexId === snapshot.session.goalVertexId ? ' goal' : ''
      }`,
    });
  }

  for (const edge of snapshot.edges) {
    if (!visible.edgeIds.has(edge.edgeId)) continue;

    const sourceVertexId = edge.sourceVertexIds[0];
    const targetVertexId = edge.targetVertexIds[0];
    if (sourceVertexId === undefined || targetVertexId === undefined) continue;
    const edgeAlias = aliases.edgeById.get(edge.edgeId) ?? edge.edgeId;
    const stateClass = `state-${edge.state}${frontierSet.has(edge.edgeId) ? ' frontier' : ''}`;
    elements.push({
      data: {
        id: buildArcId(edge.edgeId, sourceVertexId, targetVertexId),
        source: sourceVertexId,
        target: targetVertexId,
        label: edgeAlias,
        inferenceEdgeId: edge.edgeId,
        inferenceEdgeAlias: edgeAlias,
        state: edge.state,
      },
      classes: `inference-edge ${stateClass}`,
    });
  }

  return elements;
};

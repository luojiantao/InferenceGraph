import type { ElementDefinition } from 'cytoscape';
import type { EdgeId, GraphSnapshot, VertexId } from '@reasoner/schema';
import type { GraphScope } from '../state/graph-store.js';
import { buildArcId, buildGraphAliases } from './graph-aliases.js';
import {
  fallbackVertexExpansionState,
  vertexExpansionCanvasLabel,
} from './vertex-expansion-status.js';

interface VisibleSubgraph {
  readonly vertexIds: ReadonlySet<VertexId>;
  readonly edgeIds: ReadonlySet<EdgeId>;
}

export const buildExpansionStatusNodeId = (vertexId: VertexId): string =>
  `expansion-status::${vertexId}`;

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
  const expansionStateByVertexId = new Map(
    (snapshot.vertexExpansions ?? []).map((expansion) => [expansion.vertexId, expansion.state]),
  );
  const elements: ElementDefinition[] = [];

  for (const vertex of snapshot.vertices) {
    if (!visible.vertexIds.has(vertex.vertexId)) continue;
    const alias = aliases.vertexById.get(vertex.vertexId) ?? vertex.vertexId;
    const expansionState =
      expansionStateByVertexId.get(vertex.vertexId) ?? fallbackVertexExpansionState(vertex.kind);
    const expansionLabel = vertexExpansionCanvasLabel(expansionState);
    const vertexLabel = alias + ': ' + vertex.label;
    elements.push({
      data: {
        id: vertex.vertexId,
        alias,
        label: vertexLabel,
        kind: vertex.kind,
        expansionState,
        expansionLabel,
        isGoal: vertex.vertexId === snapshot.session.goalVertexId,
      },
      classes:
        'vertex kind-' +
        vertex.kind +
        ' expansion-' +
        expansionState +
        (expansionLabel.length > 0 ? ' has-expansion-status' : '') +
        (vertex.vertexId === snapshot.session.goalVertexId ? ' goal' : ''),
    });
    if (expansionLabel.length > 0) {
      elements.push({
        data: {
          id: buildExpansionStatusNodeId(vertex.vertexId),
          vertexId: vertex.vertexId,
          label: expansionLabel,
          expansionState,
        },
        classes: `expansion-status expansion-status-${expansionState}`,
        grabbable: false,
        selectable: false,
      });
    }
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

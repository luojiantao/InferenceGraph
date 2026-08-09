import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import dagre, { type DagreLayoutOptions } from 'cytoscape-dagre';
import type { EdgeId, GraphSnapshot, VertexId } from '@reasoner/schema';
import { useGraphStore, type GraphScope } from '../state/graph-store.js';
import { buildArcId, buildGraphAliases } from './graph-aliases.js';

cytoscape.use(dagre);

/** Left-to-right ranks read as premises flowing into conclusions. */
const DAGRE_LAYOUT = {
  name: 'dagre',
  rankDir: 'LR',
  nodeSep: 28,
  rankSep: 120,
  fit: false,
} satisfies DagreLayoutOptions;

const EDGE_COLORS: Record<string, string> = {
  Candidate: '#8a8f98',
  Leased: '#c98a1b',
  Completed: '#2f8f4e',
  Blocked: '#b4483c',
  Abandoned: '#6b6f76',
  Invalid: '#8b2f6b',
};

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

/**
 * The canvas contains only domain vertices and direct source-to-target arcs.
 * A logical inference edge with several sources or targets is expanded into
 * arcs that share its inferenceEdgeId; no synthetic relay vertex is created.
 */
const toElements = (
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
    elements.push({
      data: {
        id: vertex.vertexId,
        label: `${aliases.vertexById.get(vertex.vertexId) ?? vertex.vertexId}: ${vertex.label}`,
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

    for (const sourceId of edge.sourceVertexIds) {
      for (const targetId of edge.targetVertexIds) {
        const arcId = buildArcId(edge.edgeId, sourceId, targetId);
        elements.push({
          data: {
            id: arcId,
            source: sourceId,
            target: targetId,
            inferenceEdgeId: edge.edgeId,
            alias: aliases.arcById.get(arcId) ?? edge.edgeId,
            state: edge.state,
          },
          classes: `arc state-${edge.state}${frontierSet.has(edge.edgeId) ? ' frontier' : ''}`,
        });
      }
    }
  }

  return elements;
};

export const GraphCanvas = (): ReactElement => {
  const container = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const hasFittedRef = useRef(false);
  const lastViewportScopeRef = useRef<string>('All');
  const lastSessionIdRef = useRef<string | null>(null);
  const view = useGraphStore((state) => state.view);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const selectVertex = useGraphStore((state) => state.selectVertex);
  const clearSelection = useGraphStore((state) => state.clearSelection);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectedArcId = useGraphStore((state) => state.selectedArcId);
  const selectedVertexId = useGraphStore((state) => state.selectedVertexId);
  const graphScope = useGraphStore((state) => state.graphScope);
  const renderedSessionId = view?.snapshot.session.sessionId ?? null;
  const viewportScope =
    selectedVertexId === null || graphScope === 'All' ? 'All' : `${graphScope}:${selectedVertexId}`;

  const elements = useMemo(
    () =>
      view === null
        ? []
        : toElements(view.snapshot, view.frontierEdgeIds, selectedVertexId, graphScope),
    [view, selectedVertexId, graphScope],
  );

  useEffect(() => {
    if (container.current === null) return;

    const cy = cytoscape({
      container: container.current,
      elements: [],
      style: [
        {
          selector: 'node.vertex',
          style: {
            shape: 'round-rectangle',
            'background-color': '#1f2933',
            'border-color': '#3d4753',
            'border-width': 1,
            label: 'data(label)',
            color: '#e8eaed',
            'font-size': 11,
            'text-valign': 'center',
            'text-wrap': 'wrap',
            'text-max-width': '150px',
            width: 'label',
            height: 'label',
            padding: '10px',
          },
        },
        {
          selector: 'node.kind-Evidence',
          style: { shape: 'round-diamond', 'background-color': '#243b2f' },
        },
        {
          selector: 'node.goal',
          // Yellow is reserved for the one physical arc the user selected.
          style: { 'border-color': '#6fa8ff', 'border-width': 3 },
        },
        {
          selector: 'edge.arc',
          style: {
            width: 1.5,
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.8,
            'line-color': (element) => EDGE_COLORS[String(element.data('state'))] ?? '#8a8f98',
            'target-arrow-color': (element) =>
              EDGE_COLORS[String(element.data('state'))] ?? '#8a8f98',
            label: 'data(alias)',
            color: '#c7cbd4',
            'font-size': 10,
            'text-rotation': 'autorotate',
            'text-background-color': '#12141a',
            'text-background-opacity': 0.9,
            'text-background-padding': '2px',
          },
        },
        // Candidate edges are dashed; Completed edges are solid.
        {
          selector: 'edge.arc.state-Candidate',
          style: { 'line-style': 'dashed' },
        },
        {
          selector: 'edge.arc.state-Abandoned, edge.arc.state-Invalid',
          style: { 'line-style': 'dotted', opacity: 0.5 },
        },
        {
          selector: 'edge.arc.state-Completed',
          style: { width: 2.5 },
        },
        {
          selector: '.selected-element',
          style: { 'overlay-color': '#6fa8ff', 'overlay-opacity': 0.3, 'overlay-padding': 6 },
        },
        {
          selector: 'edge.arc.selected-edge',
          style: {
            width: 3,
            'line-color': '#e0b341',
            'target-arrow-color': '#e0b341',
            color: '#f2ca58',
            'arrow-scale': 1.05,
            'z-index': 10,
          },
        },
      ],
      wheelSensitivity: 0.2,
      // The app owns selection state so Cytoscape cannot add a second,
      // implicit highlight to related elements.
      autounselectify: true,
    });

    cy.on('tap', 'edge.arc', (event) =>
      selectEdge(event.target.data('inferenceEdgeId') as EdgeId, event.target.id()),
    );
    cy.on('tap', 'node.vertex', (event) => selectVertex(event.target.id() as VertexId));
    cy.on('tap', (event) => {
      if (event.target === cy) clearSelection();
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [clearSelection, selectEdge, selectVertex]);

  // Diff elements into the live instance so pan/zoom survives every poll.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;

    let topologyChanged = false;
    cy.batch(() => {
      const incoming = new Set(elements.map((element) => String(element.data.id)));
      const removed = cy.elements().filter((element) => !incoming.has(element.id()));
      if (removed.nonempty()) {
        topologyChanged = true;
        removed.remove();
      }

      for (const element of elements) {
        const id = String(element.data.id);
        const existing = cy.getElementById(id);
        if (existing.nonempty()) {
          // State/label churn restyles in place and must not move anything.
          existing.data(element.data);
          existing.classes(String(element.classes ?? ''));
        } else {
          cy.add(element);
          topologyChanged = true;
        }
      }
    });

    /**
     * Only re-run layout when nodes or arcs actually appeared or disappeared.
     * Re-laying out on every poll would refit the viewport and fight the user's
     * own pan and zoom.
     */
    if (topologyChanged && elements.length > 0) {
      cy.layout(DAGRE_LAYOUT).run();
      if (
        !hasFittedRef.current ||
        lastViewportScopeRef.current !== viewportScope ||
        lastSessionIdRef.current !== renderedSessionId
      ) {
        if (cy.nodes().length === 1) {
          cy.center(cy.elements());
        } else {
          cy.fit(cy.elements(), 48);
        }
        hasFittedRef.current = true;
      }
    }
    lastViewportScopeRef.current = viewportScope;
    lastSessionIdRef.current = renderedSessionId;
  }, [elements, renderedSessionId, viewportScope]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.elements().removeClass('selected-element selected-edge');

    if (selectedArcId !== null) {
      cy.getElementById(selectedArcId).addClass('selected-edge');
      return;
    }

    if (selectedVertexId !== null) cy.getElementById(selectedVertexId).addClass('selected-element');
  }, [elements, selectedArcId, selectedEdgeId, selectedVertexId]);

  return (
    <div className="graph-canvas" ref={container} role="application" aria-label="推理图画布" />
  );
};

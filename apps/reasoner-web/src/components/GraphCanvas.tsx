import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import dagre, { type DagreLayoutOptions } from 'cytoscape-dagre';
import type { EdgeId, VertexId } from '@reasoner/schema';
import { useGraphStore } from '../state/graph-store.js';
import { buildGraphCanvasElements } from './graph-canvas-elements.js';

cytoscape.use(dagre);

/** Left-to-right ranks read as premises flowing into conclusions. */
const DAGRE_LAYOUT = {
  name: 'dagre',
  rankDir: 'LR',
  nodeSep: 28,
  // Direct edges leave one rank interval between source and target vertices.
  rankSep: 56,
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

/** Positions native Cytoscape status nodes within their vertex's reserved lower row. */
const positionExpansionStatusNodes = (cy: Core): void => {
  cy.nodes('.expansion-status').forEach((statusNode) => {
    const vertexId = statusNode.data('vertexId');
    if (typeof vertexId !== 'string') return;

    const vertex = cy.getElementById(vertexId);
    if (vertex.empty()) return;

    const position = vertex.position();
    statusNode.position({
      x: position.x,
      y: position.y + vertex.outerHeight() / 2 - 14,
    });
  });
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
  const selectedVertexId = useGraphStore((state) => state.selectedVertexId);
  const graphScope = useGraphStore((state) => state.graphScope);
  const renderedSessionId = view?.snapshot.session.sessionId ?? null;
  const viewportScope =
    selectedVertexId === null || graphScope === 'All' ? 'All' : `${graphScope}:${selectedVertexId}`;

  const elements = useMemo(
    () =>
      view === null
        ? []
        : buildGraphCanvasElements(
            view.snapshot,
            view.frontierEdgeIds,
            selectedVertexId,
            graphScope,
          ),
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
          // Blue marks the session goal; yellow is reserved for selected relations.
          style: { 'border-color': '#6fa8ff', 'border-width': 3 },
        },
        {
          selector: 'node.vertex.has-expansion-status',
          style: {
            // Reserve a lower row for the native Cytoscape status node.
            padding: '22px',
            'text-margin-y': -8,
          },
        },
        {
          selector: 'node.expansion-status',
          style: {
            shape: 'round-rectangle',
            label: 'data(label)',
            'background-color': '#1f2933',
            'border-width': 1,
            'font-size': 10,
            'font-weight': 'bold',
            'text-valign': 'center',
            'text-halign': 'center',
            width: 'label',
            height: 'label',
            padding: '3px',
            'z-index': 20,
          },
        },
        {
          selector: 'node.expansion-status.expansion-status-Pending',
          style: { color: '#b9c3d1', 'border-color': '#64748b' },
        },
        {
          selector: 'node.expansion-status.expansion-status-Expanding',
          style: {
            color: '#ffd166',
            'background-color': '#382d17',
            'border-color': '#f5c451',
          },
        },
        {
          selector: 'node.expansion-status.expansion-status-AwaitingContext',
          style: {
            color: '#f4dda6',
            'background-color': '#312a1c',
            'border-color': '#d6a13a',
          },
        },
        {
          selector: 'node.expansion-status.expansion-status-Expanded',
          style: { color: '#a9e3c3', 'border-color': '#398463' },
        },
        {
          selector: 'node.expansion-status.expansion-status-Blocked',
          style: {
            color: '#ffd8d2',
            'background-color': '#352323',
            'border-color': '#d95c4a',
          },
        },
        {
          selector: 'node.vertex.expansion-Expanding',
          style: {
            'background-color': '#382d17',
            'border-color': '#f5c451',
            'border-width': 4,
            'underlay-color': '#f5c451',
            'underlay-opacity': 0.24,
            'underlay-padding': 6,
          },
        },
        {
          selector: 'node.vertex.expansion-AwaitingContext',
          style: {
            'background-color': '#312a1c',
            'border-color': '#d6a13a',
            'border-width': 3,
          },
        },
        {
          selector: 'node.vertex.expansion-Expanded',
          style: { 'border-color': '#398463', 'border-width': 2 },
        },
        {
          selector: 'node.vertex.expansion-Blocked',
          style: {
            'background-color': '#352323',
            'border-color': '#d95c4a',
            'border-width': 3,
          },
        },
        {
          selector: 'edge.inference-edge',
          style: {
            width: 1.5,
            'curve-style': 'bezier',
            'line-color': (element) => EDGE_COLORS[String(element.data('state'))] ?? '#8a8f98',
            'target-arrow-color': (element) =>
              EDGE_COLORS[String(element.data('state'))] ?? '#8a8f98',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.8,
            label: 'data(label)',
            color: '#e8eaed',
            'font-size': 10,
            'text-rotation': 'autorotate',
            'text-background-color': '#10161d',
            'text-background-opacity': 1,
            'text-background-padding': '2px',
          },
        },
        // Candidate edges are dashed; Completed edges are solid.
        {
          selector: 'edge.inference-edge.state-Candidate',
          style: { 'line-style': 'dashed' },
        },
        {
          selector: 'edge.inference-edge.state-Abandoned, edge.inference-edge.state-Invalid',
          style: { 'line-style': 'dotted', opacity: 0.5 },
        },
        {
          selector: 'edge.inference-edge.state-Completed',
          style: { width: 2.5 },
        },
        {
          selector: '.selected-element',
          style: { 'overlay-color': '#6fa8ff', 'overlay-opacity': 0.3, 'overlay-padding': 6 },
        },
        {
          selector: 'edge.inference-edge.selected-edge',
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

    cy.on('position', 'node.vertex', () => positionExpansionStatusNodes(cy));
    cy.on('layoutstop', () => positionExpansionStatusNodes(cy));

    cy.on('tap', 'edge.inference-edge', (event) =>
      selectEdge(event.target.data('inferenceEdgeId') as EdgeId, event.target.id()),
    );
    cy.on('tap', 'node.vertex', (event) => selectVertex(event.target.id() as VertexId));
    cy.on('tap', (event) => {
      if (event.target === cy) clearSelection();
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      if (cyRef.current === cy) {
        cyRef.current = null;
        // A fresh Cytoscape instance has no viewport to preserve.
        hasFittedRef.current = false;
      }
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
        topologyChanged = removed
          .filter((element) => !element.hasClass('expansion-status'))
          .nonempty();
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
          topologyChanged ||= !String(element.classes ?? '').includes('expansion-status');
        }
      }
    });

    /**
     * Only re-run layout when nodes or arcs actually appeared or disappeared.
     * Re-laying out on every poll would refit the viewport and fight the user's
     * own pan and zoom.
     */
    const graphElements = cy.elements().not('.expansion-status');
    if (topologyChanged && graphElements.nonempty()) {
      graphElements.layout(DAGRE_LAYOUT).run();
      if (
        !hasFittedRef.current ||
        lastViewportScopeRef.current !== viewportScope ||
        lastSessionIdRef.current !== renderedSessionId
      ) {
        if (graphElements.nodes().length === 1) {
          cy.center(graphElements);
        } else {
          cy.fit(graphElements, 48);
        }
        hasFittedRef.current = true;
      }
    }
    positionExpansionStatusNodes(cy);
    lastViewportScopeRef.current = viewportScope;
    lastSessionIdRef.current = renderedSessionId;
  }, [elements, renderedSessionId, viewportScope]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.elements().removeClass('selected-element selected-edge');

    if (selectedEdgeId !== null) {
      cy.elements().forEach((element) => {
        if (element.data('inferenceEdgeId') === selectedEdgeId) {
          element.addClass('selected-edge');
        }
      });
      return;
    }

    if (selectedVertexId !== null) cy.getElementById(selectedVertexId).addClass('selected-element');
  }, [elements, selectedEdgeId, selectedVertexId]);

  return (
    <div className="graph-canvas" ref={container} role="application" aria-label="推理图画布" />
  );
};

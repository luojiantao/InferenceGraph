import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from 'cytoscape';
import dagre, { type DagreLayoutOptions } from 'cytoscape-dagre';
import type { EdgeId, GraphSnapshot, VertexId } from '@reasoner/schema';
import { useGraphStore } from '../state/graph-store.js';

cytoscape.use(dagre);

/** Left-to-right ranks read as premises flowing into conclusions. */
const DAGRE_LAYOUT = {
  name: 'dagre',
  rankDir: 'LR',
  nodeSep: 28,
  rankSep: 70,
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

/**
 * A hyperedge cannot be drawn as one SVG line when it has several sources or
 * targets, so each inference edge becomes a small relay node with incoming arcs
 * from every source and outgoing arcs to every target. This mirrors the
 * bipartite incidence graph Core reasons over.
 *
 * EvidenceQuestions stay edge attributes and are rendered as a badge on the
 * relay node, never as their own vertex.
 */
const toElements = (snapshot: GraphSnapshot, frontier: readonly EdgeId[]): ElementDefinition[] => {
  const frontierSet = new Set<string>(frontier);
  const elements: ElementDefinition[] = [];

  for (const vertex of snapshot.vertices) {
    elements.push({
      data: {
        id: vertex.vertexId,
        label: vertex.label,
        kind: vertex.kind,
        isGoal: vertex.vertexId === snapshot.session.goalVertexId,
      },
      classes: `vertex kind-${vertex.kind}${
        vertex.vertexId === snapshot.session.goalVertexId ? ' goal' : ''
      }`,
    });
  }

  for (const edge of snapshot.edges) {
    const unanswered = edge.evidenceQuestions.filter((question) => question.answer === undefined);
    elements.push({
      data: {
        id: edge.edgeId,
        label: edge.label,
        state: edge.state,
        questionCount: edge.evidenceQuestions.length,
        unansweredCount: unanswered.length,
        agent: edge.lease?.agentId ?? '',
        onFrontier: frontierSet.has(edge.edgeId),
      },
      classes: `relay state-${edge.state}${frontierSet.has(edge.edgeId) ? ' frontier' : ''}`,
    });

    for (const sourceId of edge.sourceVertexIds) {
      elements.push({
        data: {
          id: `${edge.edgeId}::in::${sourceId}`,
          source: sourceId,
          target: edge.edgeId,
          state: edge.state,
        },
        classes: `arc state-${edge.state}`,
      });
    }
    for (const targetId of edge.targetVertexIds) {
      elements.push({
        data: {
          id: `${edge.edgeId}::out::${targetId}`,
          source: edge.edgeId,
          target: targetId,
          state: edge.state,
        },
        classes: `arc state-${edge.state}`,
      });
    }
  }

  return elements;
};

export const GraphCanvas = (): ReactElement => {
  const container = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const view = useGraphStore((state) => state.view);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const selectVertex = useGraphStore((state) => state.selectVertex);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectedVertexId = useGraphStore((state) => state.selectedVertexId);

  const elements = useMemo(
    () => (view === null ? [] : toElements(view.snapshot, view.frontierEdgeIds)),
    [view],
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
          style: { 'border-color': '#e0b341', 'border-width': 3 },
        },
        {
          selector: 'node.relay',
          style: {
            shape: 'ellipse',
            width: 16,
            height: 16,
            'background-color': (element) =>
              EDGE_COLORS[String(element.data('state'))] ?? '#8a8f98',
            label: (element: NodeSingular) =>
              Number(element.data('questionCount')) > 0
                ? `${element.data('unansweredCount')}/${element.data('questionCount')}?`
                : '',
            color: '#c9ced6',
            'font-size': 9,
            'text-valign': 'top',
            'text-margin-y': -4,
          },
        },
        {
          selector: 'node.relay.frontier',
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
      ],
      wheelSensitivity: 0.2,
    });

    cy.on('tap', 'node.relay', (event) => selectEdge(event.target.id() as EdgeId));
    cy.on('tap', 'node.vertex', (event) => selectVertex(event.target.id() as VertexId));

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [selectEdge, selectVertex]);

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
    }
  }, [elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.elements().removeClass('selected-element');
    const id = selectedEdgeId ?? selectedVertexId;
    if (id !== null) cy.getElementById(id).addClass('selected-element');
  }, [selectedEdgeId, selectedVertexId]);

  return <div className="graph-canvas" ref={container} role="application" aria-label="推理图画布" />;
};

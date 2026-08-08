import { create } from 'zustand';
import type { EdgeId, GetReasoningContextOutput, GraphEvent, SessionId, VertexId } from '@reasoner/schema';

export type SelectionKind = 'Edge' | 'Vertex' | null;
export type ViewMode = 'Status' | 'Audit';
/**
 * Reconnecting is entered on the first failed poll and only escalates to Lost
 * after repeated failures, so a single dropped request does not flash an alarm.
 */
export type ConnectionState = 'Live' | 'Reconnecting' | 'Lost';

interface GraphState {
  readonly sessionId: SessionId | null;
  readonly viewMode: ViewMode;
  readonly view: GetReasoningContextOutput | null;
  /** Highest revision ever applied. Guards against out-of-order responses. */
  readonly appliedRevision: number;
  /** Event cursor; paging is keyed on eventSeq, never on graphRevision. */
  readonly cursor: number;
  readonly events: readonly GraphEvent[];
  readonly selectionKind: SelectionKind;
  readonly selectedEdgeId: EdgeId | null;
  readonly selectedVertexId: VertexId | null;
  readonly connection: ConnectionState;
  readonly consecutiveFailures: number;
  readonly staleDropCount: number;

  setSessionId(sessionId: string | null): void;
  setViewMode(mode: ViewMode): void;
  applyView(view: GetReasoningContextOutput): void;
  reportPollFailure(): void;
  selectEdge(edgeId: EdgeId): void;
  selectVertex(vertexId: VertexId): void;
  clearSelection(): void;
}

/** Failed polls tolerated before the UI declares the connection lost. */
const LOST_AFTER_FAILURES = 3;

const EVENT_WINDOW = 500;

export const useGraphStore = create<GraphState>((set, get) => ({
  sessionId: null,
  viewMode: 'Status',
  view: null,
  appliedRevision: -1,
  cursor: 0,
  events: [],
  selectionKind: null,
  selectedEdgeId: null,
  selectedVertexId: null,
  connection: 'Live',
  consecutiveFailures: 0,
  staleDropCount: 0,

  setSessionId: (sessionId) => {
    const next = sessionId === null ? null : (sessionId as SessionId);
    if (get().sessionId === next) return;
    set({
      sessionId: next,
      view: null,
      appliedRevision: -1,
      cursor: 0,
      events: [],
      selectionKind: null,
      selectedEdgeId: null,
      selectedVertexId: null,
      connection: 'Live',
      consecutiveFailures: 0,
    });
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  applyView: (view) => {
    const state = get();
    const incoming = view.snapshot.graphRevision;

    /**
     * Out-of-order protection: a slower earlier request must never overwrite a
     * newer snapshot. Equal revisions are re-applied because a single revision
     * can carry several events, and a later page may extend the event stream
     * without moving the revision.
     */
    if (incoming < state.appliedRevision) {
      set({
        staleDropCount: state.staleDropCount + 1,
        connection: 'Live',
        consecutiveFailures: 0,
      });
      return;
    }

    // Append only genuinely new events, then keep a bounded window.
    const known = new Set(state.events.map((event) => event.eventSeq));
    const merged = [...state.events, ...view.events.filter((event) => !known.has(event.eventSeq))]
      .sort((left, right) => left.eventSeq - right.eventSeq)
      .slice(-EVENT_WINDOW);

    set({
      view,
      appliedRevision: incoming,
      cursor: Math.max(state.cursor, view.nextEventSeq),
      events: merged,
      connection: 'Live',
      consecutiveFailures: 0,
    });
  },

  reportPollFailure: () => {
    const failures = get().consecutiveFailures + 1;
    set({
      consecutiveFailures: failures,
      connection: failures >= LOST_AFTER_FAILURES ? 'Lost' : 'Reconnecting',
    });
  },

  selectEdge: (edgeId) =>
    set({ selectionKind: 'Edge', selectedEdgeId: edgeId, selectedVertexId: null }),
  selectVertex: (vertexId) =>
    set({ selectionKind: 'Vertex', selectedVertexId: vertexId, selectedEdgeId: null }),
  clearSelection: () => set({ selectionKind: null, selectedEdgeId: null, selectedVertexId: null }),
}));

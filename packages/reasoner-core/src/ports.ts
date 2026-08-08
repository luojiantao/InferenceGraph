import type {
  ContextProjectionRecord,
  EdgeId,
  EventSeq,
  GraphEventKind,
  GraphRevision,
  GraphSnapshot,
  InferenceEdge,
  IsoTimestamp,
  ReasoningSession,
  Result,
  SessionId,
  Vertex,
  VertexId,
  AgentId,
} from '@reasoner/schema';

export interface Clock {
  now(): IsoTimestamp;
}

export interface IdGenerator {
  newId(prefix: string): string;
}

/**
 * Event as produced by the Core. `eventSeq` and `graphRevision` are deliberately
 * absent: only the storage layer assigns them, inside the committing
 * transaction, so the session-wide sequence can never develop a gap.
 */
export interface GraphEventDraft {
  readonly kind: GraphEventKind;
  readonly actorAgentId: AgentId;
  readonly vertexId?: VertexId;
  readonly edgeId?: EdgeId;
  readonly detail?: Record<string, unknown>;
}

/**
 * The complete set of changes one command wants to commit. The storage layer
 * applies the whole draft atomically, bumps GraphRevision exactly once and
 * appends every event with a strictly increasing eventSeq.
 */
export interface MutationDraft {
  readonly upsertVertices?: readonly Vertex[];
  readonly upsertEdges?: readonly InferenceEdge[];
  readonly sessionPatch?: Partial<
    Pick<
      ReasoningSession,
      'goalState' | 'strategy' | 'projectionPolicy' | 'structuralError' | 'finishedReason'
    >
  >;
  readonly events: readonly GraphEventDraft[];
}

export interface MutationOutcome {
  readonly graphRevision: GraphRevision;
  readonly lastEventSeq: EventSeq;
  readonly snapshot: GraphSnapshot;
}

/**
 * Planner callback executed *inside* the write transaction, against the snapshot
 * read after the lock is taken. Cycle checks and state-machine validation run
 * here so their result cannot be invalidated between check and write.
 */
export type MutationPlanner = (
  snapshot: GraphSnapshot,
  now: IsoTimestamp,
) => Result<MutationDraft>;

export interface CreateSessionRequest {
  readonly session: ReasoningSession;
  readonly goalVertex: Vertex;
  readonly events: readonly GraphEventDraft[];
}

export interface ListSessionsOptions {
  readonly includeFinished: boolean;
  readonly limit: number;
}

export interface ReasonerRepository {
  createSession(request: CreateSessionRequest): Promise<Result<MutationOutcome>>;
  getSession(sessionId: SessionId): Promise<Result<ReasoningSession>>;
  listSessions(options: ListSessionsOptions): Promise<Result<readonly ReasoningSession[]>>;
  getSnapshot(sessionId: SessionId): Promise<Result<GraphSnapshot>>;
  listEvents(
    sessionId: SessionId,
    afterEventSeq: number,
    limit: number,
  ): Promise<Result<readonly import('@reasoner/schema').GraphEvent[]>>;

  /**
   * Atomic read-modify-write. Opens an immediate transaction, verifies the
   * caller's expectedRevision (returns RevisionConflict on mismatch), runs the
   * planner against the locked snapshot, then commits the draft with a single
   * revision increment.
   */
  mutate(
    sessionId: SessionId,
    expectedRevision: GraphRevision,
    plan: MutationPlanner,
  ): Promise<Result<MutationOutcome>>;

  saveContextProjection(record: ContextProjectionRecord): Promise<Result<void>>;
  getContextProjection(
    sessionId: SessionId,
    projectionId: string,
  ): Promise<Result<ContextProjectionRecord>>;
  /** Most recent archived projection for a subject, used for claim-time hash lookup. */
  findLatestContextProjection(
    sessionId: SessionId,
    subjectKind: 'Vertex' | 'Edge',
    subjectId: string,
  ): Promise<Result<ContextProjectionRecord | null>>;
}

/**
 * Append-only JSONL mirror of committed events. A failure here never rolls back
 * the SQLite transaction; it is reported and can be replayed.
 */
export interface AuditWriter {
  append(
    sessionId: SessionId,
    events: readonly import('@reasoner/schema').GraphEvent[],
  ): Promise<Result<void>>;
}

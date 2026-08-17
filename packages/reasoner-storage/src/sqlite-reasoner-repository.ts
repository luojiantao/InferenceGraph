import type { DatabaseSync } from 'node:sqlite';
import {
  GraphEventSchema,
  InferenceEdgeSchema,
  ReasoningSessionSchema,
  VertexExpansionSchema,
  VertexSchema,
  err,
  isErr,
  ok,
  type ContextProjectionRecord,
  type EdgeId,
  type EventSeq,
  type GraphEvent,
  type GraphRevision,
  type GraphSnapshot,
  type InferenceEdge,
  type IsoTimestamp,
  NULL_LOGGER,
  type Logger,
  type ReasoningSession,
  type Result,
  type SessionId,
  type Vertex,
  type VertexExpansion,
  type VertexId,
} from '@reasoner/schema';
import {
  hashCanonical,
  normalizeText,
  type Clock,
  type CreateSessionRequest,
  type GraphEventDraft,
  type ListSessionsOptions,
  type MutationOutcome,
  type MutationPlanner,
  type ReasonerRepository,
} from '@reasoner/core';

type Row = Record<string, unknown>;

const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value));
const asNumber = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0);
const asOptionalString = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : asString(value);

/**
 * SQLite-backed repository.
 *
 * Driver note: this uses Node's built-in `node:sqlite` rather than an ORM with a
 * native addon. It needs no compiler toolchain on Windows and gives direct
 * control over `BEGIN IMMEDIATE`, which the revision compare-and-set depends on.
 * The Core only ever sees the ReasonerRepository port, so no SQL leaks upward.
 */
export class SqliteReasonerRepository implements ReasonerRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
    private readonly log: Logger = NULL_LOGGER,
  ) {}

  async createSession(request: CreateSessionRequest): Promise<Result<MutationOutcome>> {
    const { session, goalVertex, vertexExpansions, events } = request;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.db
        .prepare('SELECT session_id FROM reasoning_sessions WHERE session_id = ?')
        .get(session.sessionId);
      if (existing !== undefined) {
        this.db.exec('ROLLBACK');
        return err('DuplicateEntity', `session ${session.sessionId} already exists`, {
          sessionId: session.sessionId,
        });
      }

      this.db
        .prepare(
          `INSERT INTO reasoning_sessions (
             session_id, goal_vertex_id, goal_state, strategy, projection_policy,
             max_edges, max_depth, max_lease_seconds, graph_revision, last_event_seq,
             structural_error, finished_reason, alias, tags_json,
             created_by_agent, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          session.sessionId,
          session.goalVertexId,
          session.goalState,
          session.strategy,
          session.projectionPolicy,
          session.budget.maxEdges,
          session.budget.maxDepth,
          session.budget.maxLeaseSeconds,
          session.graphRevision,
          0,
          null,
          null,
          session.alias ?? null,
          JSON.stringify(session.tags),
          session.createdByAgentId,
          session.createdAt,
          session.updatedAt,
        );

      this.insertVertex(session.sessionId, goalVertex);
      for (const expansion of vertexExpansions) {
        this.upsertVertexExpansion(session.sessionId, expansion, session.graphRevision);
      }
      const lastEventSeq = this.appendEvents(
        session.sessionId,
        session.graphRevision,
        events,
        this.clock.now(),
        0,
      );
      this.db
        .prepare('UPDATE reasoning_sessions SET last_event_seq = ? WHERE session_id = ?')
        .run(lastEventSeq, session.sessionId);

      this.db.exec('COMMIT');
    } catch (cause) {
      this.safeRollback();
      return err('StorageFailure', `failed to create session: ${String(cause)}`);
    }

    const snapshot = await this.getSnapshot(session.sessionId);
    if (isErr(snapshot)) return snapshot;
    return ok({
      graphRevision: snapshot.value.graphRevision,
      lastEventSeq: snapshot.value.session.lastEventSeq as EventSeq,
      snapshot: snapshot.value,
    });
  }

  async getSession(sessionId: SessionId): Promise<Result<ReasoningSession>> {
    const row = this.db
      .prepare('SELECT * FROM reasoning_sessions WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    if (row === undefined) {
      return err('SessionNotFound', `session ${sessionId} not found`, { sessionId });
    }
    return this.parseSession(row);
  }

  async listSessions(options: ListSessionsOptions): Promise<Result<readonly ReasoningSession[]>> {
    const sql = options.includeFinished
      ? 'SELECT * FROM reasoning_sessions ORDER BY updated_at DESC, created_at DESC LIMIT ?'
      : `SELECT * FROM reasoning_sessions
         WHERE goal_state NOT IN ('GoalSatisfied','GoalConflicted','Exhausted','BudgetExceeded','StructurallyInvalid')
         ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(options.limit) as Row[];
    const sessions: ReasoningSession[] = [];
    for (const row of rows) {
      const parsed = this.parseSession(row);
      if (isErr(parsed)) return parsed;
      sessions.push(parsed.value);
    }
    return ok(sessions);
  }

  async getSnapshot(sessionId: SessionId): Promise<Result<GraphSnapshot>> {
    const session = await this.getSession(sessionId);
    if (isErr(session)) return session;
    return this.readSnapshot(session.value);
  }

  async listEvents(
    sessionId: SessionId,
    afterEventSeq: number,
    limit: number,
  ): Promise<Result<readonly GraphEvent[]>> {
    const rows = this.db
      .prepare(
        `SELECT * FROM graph_events
         WHERE session_id = ? AND event_seq > ?
         ORDER BY event_seq ASC LIMIT ?`,
      )
      .all(sessionId, afterEventSeq, limit) as Row[];

    const events: GraphEvent[] = [];
    for (const row of rows) {
      const parsed = GraphEventSchema.safeParse({
        eventSeq: asNumber(row['event_seq']),
        sessionId: asString(row['session_id']),
        graphRevision: asNumber(row['graph_revision']),
        kind: asString(row['kind']),
        vertexId: asOptionalString(row['vertex_id']),
        edgeId: asOptionalString(row['edge_id']),
        actorAgentId: asString(row['actor_agent_id']),
        detail: JSON.parse(asString(row['detail_json'])) as Record<string, unknown>,
        occurredAt: asString(row['occurred_at']),
      });
      if (!parsed.success) {
        return err('StorageFailure', `corrupt graph_event row: ${parsed.error.message}`);
      }
      events.push(parsed.data);
    }
    return ok(events);
  }

  /**
   * Atomic read-modify-write.
   *
   * Everything happens under one BEGIN IMMEDIATE: the revision check, the
   * planner (which performs cycle detection and state validation against the
   * locked snapshot), the writes, the single revision bump and the event append.
   * Expired-lease reclamation planned by the caller therefore shares this same
   * revision bump instead of consuming one of its own.
   */
  async mutate(
    sessionId: SessionId,
    expectedRevision: GraphRevision,
    plan: MutationPlanner,
  ): Promise<Result<MutationOutcome>> {
    let committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');

      const sessionRow = this.db
        .prepare('SELECT * FROM reasoning_sessions WHERE session_id = ?')
        .get(sessionId) as Row | undefined;
      if (sessionRow === undefined) {
        this.db.exec('ROLLBACK');
        return err('SessionNotFound', `session ${sessionId} not found`, { sessionId });
      }

      const session = this.parseSession(sessionRow);
      if (isErr(session)) {
        this.db.exec('ROLLBACK');
        return session;
      }

      if (session.value.graphRevision !== expectedRevision) {
        this.db.exec('ROLLBACK');
        return err(
          'RevisionConflict',
          `session ${sessionId} is at revision ${session.value.graphRevision}, caller sent ${expectedRevision}`,
          { actual: session.value.graphRevision, expected: expectedRevision },
        );
      }

      const snapshot = this.readSnapshot(session.value);
      if (isErr(snapshot)) {
        this.db.exec('ROLLBACK');
        return snapshot;
      }

      const now = this.clock.now();
      const draft = plan(snapshot.value, now);
      if (isErr(draft)) {
        // Planner rejection (cycle, bad transition, ...) leaves no trace at all.
        this.db.exec('ROLLBACK');
        return draft;
      }

      const hasChanges =
        (draft.value.upsertVertices?.length ?? 0) > 0 ||
        (draft.value.upsertVertexExpansions?.length ?? 0) > 0 ||
        (draft.value.upsertEdges?.length ?? 0) > 0 ||
        draft.value.sessionPatch !== undefined ||
        draft.value.events.length > 0;

      if (!hasChanges) {
        // Idempotent no-op (e.g. dedupe hit): do not burn a revision.
        this.db.exec('COMMIT');
        committed = true;
        return ok({
          graphRevision: session.value.graphRevision,
          lastEventSeq: session.value.lastEventSeq as EventSeq,
          snapshot: snapshot.value,
        });
      }

      const nextRevision = (session.value.graphRevision + 1) as GraphRevision;

      for (const vertex of draft.value.upsertVertices ?? []) {
        this.insertVertex(sessionId, vertex);
      }
      for (const expansion of draft.value.upsertVertexExpansions ?? []) {
        this.upsertVertexExpansion(sessionId, expansion, nextRevision);
      }
      for (const edge of draft.value.upsertEdges ?? []) {
        this.upsertEdge(sessionId, edge, nextRevision);
      }

      const patch = draft.value.sessionPatch;
      const hasAliasPatch = patch !== undefined && 'alias' in patch;
      const hasTagsPatch = patch !== undefined && 'tags' in patch;
      this.db
        .prepare(
          `UPDATE reasoning_sessions
             SET graph_revision = ?, updated_at = ?,
                  max_edges = COALESCE(?, max_edges),
                  goal_state = COALESCE(?, goal_state),
                  strategy = COALESCE(?, strategy),
                  projection_policy = COALESCE(?, projection_policy),
                  structural_error = COALESCE(?, structural_error),
                  finished_reason = COALESCE(?, finished_reason),
                  alias = CASE WHEN ? THEN ? ELSE alias END,
                  tags_json = CASE WHEN ? THEN ? ELSE tags_json END
           WHERE session_id = ?`,
        )
        .run(
          nextRevision,
          now,
          patch?.budget?.maxEdges ?? null,
          patch?.goalState ?? null,
          patch?.strategy ?? null,
          patch?.projectionPolicy ?? null,
          patch?.structuralError ?? null,
          patch?.finishedReason ?? null,
          hasAliasPatch ? 1 : 0,
          hasAliasPatch ? (patch?.alias ?? null) : null,
          hasTagsPatch ? 1 : 0,
          hasTagsPatch ? JSON.stringify(patch?.tags ?? []) : null,
          sessionId,
        );

      const lastEventSeq = this.appendEvents(
        sessionId,
        nextRevision,
        draft.value.events,
        now,
        session.value.lastEventSeq,
      );
      this.db
        .prepare('UPDATE reasoning_sessions SET last_event_seq = ? WHERE session_id = ?')
        .run(lastEventSeq, sessionId);

      this.db.exec('COMMIT');
      committed = true;

      const after = await this.getSnapshot(sessionId);
      if (isErr(after)) return after;
      return ok({
        graphRevision: nextRevision,
        lastEventSeq: lastEventSeq as EventSeq,
        snapshot: after.value,
      });
    } catch (cause) {
      if (!committed) this.safeRollback();
      // The Result carries only a message, so the stack is preserved here or
      // it is lost for good.
      this.log.error(
        { sessionId, expectedRevision, err: cause, rolledBack: !committed },
        'mutation threw',
      );
      return err('StorageFailure', `mutation failed: ${String(cause)}`);
    }
  }

  async deleteSession(
    sessionId: SessionId,
    expectedRevision: GraphRevision,
  ): Promise<Result<void>> {
    let committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db
        .prepare('SELECT graph_revision FROM reasoning_sessions WHERE session_id = ?')
        .get(sessionId) as Row | undefined;
      if (row === undefined) {
        this.db.exec('ROLLBACK');
        return err('SessionNotFound', `session ${sessionId} not found`, { sessionId });
      }

      const actual = asNumber(row['graph_revision']) as GraphRevision;
      if (actual !== expectedRevision) {
        this.db.exec('ROLLBACK');
        return err(
          'RevisionConflict',
          `session ${sessionId} is at revision ${actual}, caller sent ${expectedRevision}`,
          { actual, expected: expectedRevision },
        );
      }

      // Do this explicitly as well as relying on ON DELETE CASCADE: databases
      // upgraded from the earliest schema may not have had every foreign key.
      for (const table of [
        'context_projections',
        'graph_events',
        'vertex_expansions',
        'edge_leases',
        'evidence_questions',
        'edge_sources',
        'edge_targets',
        'inference_edges',
        'vertices',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
      this.db.prepare('DELETE FROM reasoning_sessions WHERE session_id = ?').run(sessionId);
      this.db.exec('COMMIT');
      committed = true;
      return ok(undefined);
    } catch (cause) {
      if (!committed) this.safeRollback();
      this.log.error(
        { sessionId, expectedRevision, err: cause, rolledBack: !committed },
        'session deletion threw',
      );
      return err('StorageFailure', `failed to delete session: ${String(cause)}`);
    }
  }

  async saveContextProjection(record: ContextProjectionRecord): Promise<Result<void>> {
    try {
      // Audit-only side write: no revision bump, no event.
      this.db
        .prepare(
          `INSERT OR REPLACE INTO context_projections (
             projection_id, session_id, subject_kind, subject_id, policy,
             graph_revision, snapshot_hash, context_hash,
             included_vertex_ids, included_edge_ids, omitted_vertex_ids, omitted_edge_ids,
             expansion_handles, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.projectionId,
          record.sessionId,
          record.subjectKind,
          record.subjectId,
          record.policy,
          record.graphRevision,
          record.snapshotHash,
          record.contextHash,
          JSON.stringify(record.includedVertexIds),
          JSON.stringify(record.includedEdgeIds),
          JSON.stringify(record.omittedVertexIds),
          JSON.stringify(record.omittedEdgeIds),
          JSON.stringify(record.expansionHandles),
          record.createdAt,
        );
      return ok(undefined);
    } catch (cause) {
      return err('StorageFailure', `failed to save context projection: ${String(cause)}`);
    }
  }

  async getContextProjection(
    sessionId: SessionId,
    projectionId: string,
  ): Promise<Result<ContextProjectionRecord>> {
    const row = this.db
      .prepare('SELECT * FROM context_projections WHERE session_id = ? AND projection_id = ?')
      .get(sessionId, projectionId) as Row | undefined;
    if (row === undefined) {
      return err('InvalidInput', `context projection ${projectionId} not found`, { projectionId });
    }
    return ok(this.parseProjection(row));
  }

  async findLatestContextProjection(
    sessionId: SessionId,
    subjectKind: 'Vertex' | 'Edge',
    subjectId: string,
  ): Promise<Result<ContextProjectionRecord | null>> {
    const row = this.db
      .prepare(
        `SELECT * FROM context_projections
         WHERE session_id = ? AND subject_kind = ? AND subject_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId, subjectKind, subjectId) as Row | undefined;
    return ok(row === undefined ? null : this.parseProjection(row));
  }

  // --- internals -----------------------------------------------------------

  private safeRollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // Already rolled back or no transaction open; nothing to recover.
    }
  }

  private parseProjection(row: Row): ContextProjectionRecord {
    return {
      projectionId: asString(row['projection_id']),
      sessionId: asString(row['session_id']) as SessionId,
      subjectKind: asString(row['subject_kind']) as 'Vertex' | 'Edge',
      subjectId: asString(row['subject_id']),
      policy: asString(row['policy']) as ContextProjectionRecord['policy'],
      graphRevision: asNumber(row['graph_revision']) as GraphRevision,
      snapshotHash: asString(row['snapshot_hash']),
      contextHash: asString(row['context_hash']),
      includedVertexIds: JSON.parse(asString(row['included_vertex_ids'])) as VertexId[],
      includedEdgeIds: JSON.parse(asString(row['included_edge_ids'])) as EdgeId[],
      omittedVertexIds: JSON.parse(asString(row['omitted_vertex_ids'])) as VertexId[],
      omittedEdgeIds: JSON.parse(asString(row['omitted_edge_ids'])) as EdgeId[],
      expansionHandles: JSON.parse(
        asString(row['expansion_handles']),
      ) as ContextProjectionRecord['expansionHandles'],
      createdAt: asString(row['created_at']) as IsoTimestamp,
    };
  }

  private parseSession(row: Row): Result<ReasoningSession> {
    let tags: unknown;
    try {
      tags = JSON.parse(asString(row['tags_json'] ?? '[]'));
    } catch (cause) {
      return err('StorageFailure', `corrupt session tags_json: ${String(cause)}`);
    }

    const parsed = ReasoningSessionSchema.safeParse({
      sessionId: asString(row['session_id']),
      alias: asOptionalString(row['alias']),
      tags,
      goalVertexId: asString(row['goal_vertex_id']),
      goalState: asString(row['goal_state']),
      strategy: asString(row['strategy']),
      projectionPolicy: asString(row['projection_policy']),
      budget: {
        maxEdges: asNumber(row['max_edges']),
        maxDepth: asNumber(row['max_depth']),
        maxLeaseSeconds: asNumber(row['max_lease_seconds']),
      },
      graphRevision: asNumber(row['graph_revision']),
      lastEventSeq: asNumber(row['last_event_seq']),
      structuralError: asOptionalString(row['structural_error']),
      finishedReason: asOptionalString(row['finished_reason']),
      createdByAgentId: asString(row['created_by_agent']),
      createdAt: asString(row['created_at']),
      updatedAt: asString(row['updated_at']),
    });
    return parsed.success
      ? ok(parsed.data)
      : err('StorageFailure', `corrupt session row: ${parsed.error.message}`);
  }

  private readSnapshot(session: ReasoningSession): Result<GraphSnapshot> {
    const vertexRows = this.db
      .prepare('SELECT * FROM vertices WHERE session_id = ? ORDER BY vertex_id')
      .all(session.sessionId) as Row[];

    const vertices: Vertex[] = [];
    for (const row of vertexRows) {
      const parsed = VertexSchema.safeParse({
        vertexId: asString(row['vertex_id']),
        referenceId: asString(row['reference_id']),
        kind: asString(row['kind']),
        label: asString(row['label']),
        payload: JSON.parse(asString(row['payload_json'])) as Record<string, unknown>,
        dedupeKey: asOptionalString(row['dedupe_key']),
        createdByAgentId: asString(row['created_by_agent']),
        createdAt: asString(row['created_at']),
        createdAtRevision: asNumber(row['created_at_revision']),
      });
      if (!parsed.success) {
        return err('StorageFailure', `corrupt vertex row: ${parsed.error.message}`);
      }
      vertices.push(parsed.data);
    }

    const expansionRows = this.db
      .prepare('SELECT * FROM vertex_expansions WHERE session_id = ? ORDER BY vertex_id')
      .all(session.sessionId) as Row[];
    const vertexIds = new Set(vertices.map((vertex) => vertex.vertexId));
    const vertexExpansions: VertexExpansion[] = [];
    for (const row of expansionRows) {
      const vertexId = asString(row['vertex_id']);
      if (!vertexIds.has(vertexId as VertexId)) {
        return err(
          'StorageFailure',
          `vertex_expansion row references missing vertex ${vertexId}`,
          { vertexId },
        );
      }
      const leaseId = asOptionalString(row['lease_id']);
      const parsed = VertexExpansionSchema.safeParse({
        vertexId,
        state: asString(row['state']),
        lease:
          leaseId === undefined
            ? undefined
            : {
                leaseId,
                vertexId,
                agentId: asString(row['agent_id']),
                acquiredAt: asString(row['acquired_at']),
                expiresAt: asString(row['expires_at']),
              },
        reason: asOptionalString(row['reason']),
        updatedAt: asString(row['updated_at']),
        updatedAtRevision: asNumber(row['updated_at_revision']),
      });
      if (!parsed.success) {
        return err('StorageFailure', `corrupt vertex_expansion row ${vertexId}: ${parsed.error.message}`);
      }
      vertexExpansions.push(parsed.data);
    }

    const edgeRows = this.db
      .prepare('SELECT * FROM inference_edges WHERE session_id = ? ORDER BY edge_id')
      .all(session.sessionId) as Row[];

    const edges: InferenceEdge[] = [];
    for (const row of edgeRows) {
      const edgeId = asString(row['edge_id']);
      const sources = (
        this.db
          .prepare(
            'SELECT vertex_id FROM edge_sources WHERE session_id = ? AND edge_id = ? ORDER BY ordinal',
          )
          .all(session.sessionId, edgeId) as Row[]
      ).map((source) => asString(source['vertex_id']));
      const targets = (
        this.db
          .prepare(
            'SELECT vertex_id FROM edge_targets WHERE session_id = ? AND edge_id = ? ORDER BY ordinal',
          )
          .all(session.sessionId, edgeId) as Row[]
      ).map((target) => asString(target['vertex_id']));

      const questions = (
        this.db
          .prepare(
            'SELECT * FROM evidence_questions WHERE session_id = ? AND edge_id = ? ORDER BY ordinal',
          )
          .all(session.sessionId, edgeId) as Row[]
      ).map((question) => ({
        questionId: asString(question['question_id']),
        prompt: asString(question['prompt']),
        answer: asOptionalString(question['answer']),
        answeredByAgentId: asOptionalString(question['answered_by_agent']),
        answeredAt: asOptionalString(question['answered_at']),
        answeredAtRevision:
          question['answered_at_revision'] === null ||
          question['answered_at_revision'] === undefined
            ? undefined
            : asNumber(question['answered_at_revision']),
      }));

      const leaseRow = this.db
        .prepare(
          `SELECT * FROM edge_leases
           WHERE session_id = ? AND edge_id = ? AND released_at IS NULL LIMIT 1`,
        )
        .get(session.sessionId, edgeId) as Row | undefined;

      const parsed = InferenceEdgeSchema.safeParse({
        edgeId,
        referenceId: asString(row['reference_id']),
        formulaId: asString(row['formula_id']),
        sourceVertexIds: sources,
        targetVertexIds: targets,
        label: asString(row['label']),
        state: asString(row['state']),
        cost: asNumber(row['cost']),
        priority: asNumber(row['priority']),
        evidenceQuestions: questions,
        conclusion: asOptionalString(row['conclusion']),
        blockedReason: asOptionalString(row['blocked_reason']),
        lease:
          leaseRow === undefined
            ? undefined
            : {
                leaseId: asString(leaseRow['lease_id']),
                edgeId,
                agentId: asString(leaseRow['agent_id']),
                acquiredAt: asString(leaseRow['acquired_at']),
                expiresAt: asString(leaseRow['expires_at']),
                inputContextHash: asString(leaseRow['input_context_hash']),
              },
        dedupeKey: asOptionalString(row['dedupe_key']),
        proposedByAgentId: asString(row['proposed_by_agent']),
        createdAt: asString(row['created_at']),
        createdAtRevision: asNumber(row['created_at_revision']),
        updatedAtRevision: asNumber(row['updated_at_revision']),
      });
      if (!parsed.success) {
        return err('StorageFailure', `corrupt edge row ${edgeId}: ${parsed.error.message}`);
      }
      edges.push(parsed.data);
    }

    const snapshotHash = hashCanonical({ session, vertices, edges, vertexExpansions });
    return ok({
      session,
      vertices,
      edges,
      vertexExpansions,
      graphRevision: session.graphRevision,
      snapshotHash,
    });
  }

  private insertVertex(sessionId: SessionId, vertex: Vertex): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO vertices (
           session_id, vertex_id, reference_id, kind, label, payload_json, dedupe_key,
           created_by_agent, created_at, created_at_revision
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        sessionId,
        vertex.vertexId,
        vertex.referenceId,
        vertex.kind,
        vertex.label,
        JSON.stringify(vertex.payload),
        vertex.dedupeKey ?? null,
        vertex.createdByAgentId,
        vertex.createdAt,
        vertex.createdAtRevision,
      );
  }

  private upsertVertexExpansion(
    sessionId: SessionId,
    expansion: VertexExpansion,
    revision: GraphRevision,
  ): void {
    this.db
      .prepare(
        `INSERT INTO vertex_expansions (
           session_id, vertex_id, state, lease_id, agent_id, acquired_at, expires_at,
           reason, updated_at, updated_at_revision
         ) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, vertex_id) DO UPDATE SET
           state = excluded.state,
           lease_id = excluded.lease_id,
           agent_id = excluded.agent_id,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at,
           reason = excluded.reason,
           updated_at = excluded.updated_at,
           updated_at_revision = excluded.updated_at_revision`,
      )
      .run(
        sessionId,
        expansion.vertexId,
        expansion.state,
        expansion.lease?.leaseId ?? null,
        expansion.lease?.agentId ?? null,
        expansion.lease?.acquiredAt ?? null,
        expansion.lease?.expiresAt ?? null,
        expansion.reason ?? null,
        expansion.updatedAt,
        revision,
      );
  }

  private upsertEdge(sessionId: SessionId, edge: InferenceEdge, revision: GraphRevision): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inference_edges (
           session_id, edge_id, reference_id, formula_id, label, state, cost, priority, conclusion,
           blocked_reason, dedupe_key, proposed_by_agent, created_at, created_at_revision,
           updated_at_revision
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        sessionId,
        edge.edgeId,
        edge.referenceId,
        edge.formulaId,
        edge.label,
        edge.state,
        edge.cost,
        edge.priority,
        edge.conclusion ?? null,
        edge.blockedReason ?? null,
        edge.dedupeKey ?? null,
        edge.proposedByAgentId,
        edge.createdAt,
        edge.createdAtRevision,
        revision,
      );

    this.db
      .prepare('DELETE FROM edge_sources WHERE session_id = ? AND edge_id = ?')
      .run(sessionId, edge.edgeId);
    edge.sourceVertexIds.forEach((vertexId, ordinal) => {
      this.db
        .prepare(
          'INSERT INTO edge_sources (session_id, edge_id, vertex_id, ordinal) VALUES (?,?,?,?)',
        )
        .run(sessionId, edge.edgeId, vertexId, ordinal);
    });

    this.db
      .prepare('DELETE FROM edge_targets WHERE session_id = ? AND edge_id = ?')
      .run(sessionId, edge.edgeId);
    edge.targetVertexIds.forEach((vertexId, ordinal) => {
      this.db
        .prepare(
          'INSERT INTO edge_targets (session_id, edge_id, vertex_id, ordinal) VALUES (?,?,?,?)',
        )
        .run(sessionId, edge.edgeId, vertexId, ordinal);
    });

    this.db
      .prepare('DELETE FROM evidence_questions WHERE session_id = ? AND edge_id = ?')
      .run(sessionId, edge.edgeId);
    edge.evidenceQuestions.forEach((question, ordinal) => {
      this.db
        .prepare(
          `INSERT INTO evidence_questions (
             session_id, edge_id, question_id, prompt, normalized_prompt,
             answer, answered_by_agent, answered_at, answered_at_revision, ordinal
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          sessionId,
          edge.edgeId,
          question.questionId,
          question.prompt,
          normalizeText(question.prompt),
          question.answer ?? null,
          question.answeredByAgentId ?? null,
          question.answeredAt ?? null,
          question.answeredAtRevision ?? null,
          ordinal,
        );
    });

    // Lease table is the source of truth for concurrency; keep it in step with
    // the edge's lease field. Releasing marks the row rather than deleting it,
    // so the unique active-lease index stays meaningful and history is kept.
    if (edge.lease === undefined) {
      this.db
        .prepare(
          `UPDATE edge_leases SET released_at = ?
           WHERE session_id = ? AND edge_id = ? AND released_at IS NULL`,
        )
        .run(this.clock.now(), sessionId, edge.edgeId);
    } else {
      this.db
        .prepare(
          `UPDATE edge_leases SET released_at = ?
           WHERE session_id = ? AND edge_id = ? AND released_at IS NULL AND lease_id != ?`,
        )
        .run(this.clock.now(), sessionId, edge.edgeId, edge.lease.leaseId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO edge_leases (
             session_id, edge_id, lease_id, agent_id, acquired_at, expires_at,
             input_context_hash, released_at
           ) VALUES (?,?,?,?,?,?,?,NULL)`,
        )
        .run(
          sessionId,
          edge.edgeId,
          edge.lease.leaseId,
          edge.lease.agentId,
          edge.lease.acquiredAt,
          edge.lease.expiresAt,
          edge.lease.inputContextHash,
        );
    }
  }

  /**
   * Appends events with strictly increasing event_seq continuing from the
   * session's current maximum. Several events from one transaction share a
   * graph_revision but each gets its own seq, so the cursor never has a gap.
   */
  private appendEvents(
    sessionId: SessionId,
    revision: GraphRevision,
    events: readonly GraphEventDraft[],
    now: IsoTimestamp,
    startingSeq: number,
  ): number {
    let seq = startingSeq;
    for (const event of events) {
      seq += 1;
      this.db
        .prepare(
          `INSERT INTO graph_events (
             session_id, event_seq, graph_revision, kind, vertex_id, edge_id,
             actor_agent_id, detail_json, occurred_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          sessionId,
          seq,
          revision,
          event.kind,
          event.vertexId ?? null,
          event.edgeId ?? null,
          event.actorAgentId,
          JSON.stringify(event.detail ?? {}),
          now,
        );
    }
    return seq;
  }
}

import {
  buildGraphAliases,
  err,
  isErr,
  NULL_LOGGER,
  ok,
  type AddEvidenceVertexInput,
  type AddEvidenceVertexOutput,
  type AddStateVertexInput,
  type AddStateVertexOutput,
  type AgentId,
  type BlockInferenceEdgeInput,
  type BlockInferenceEdgeOutput,
  type ClaimInferenceEdgeInput,
  type ClaimInferenceEdgeOutput,
  type ClaimInferenceEdgesInput,
  type ClaimInferenceEdgesOutput,
  type CompleteInferenceEdgeInput,
  type CompleteInferenceEdgeOutput,
  type CreateReasoningSessionInput,
  type CreateReasoningSessionOutput,
  type DeleteReasoningSessionInput,
  type DeleteReasoningSessionOutput,
  type EdgeId,
  type EdgeExecutionContext,
  type EdgeReferenceId,
  type EvidenceQuestion,
  type FinishReasoningSessionInput,
  type FinishReasoningSessionOutput,
  type GetContextForEdgeInput,
  type GetContextForEdgeOutput,
  type GetContextForVertexInput,
  type GetContextForVertexOutput,
  type GetInferenceEdgeInput,
  type GetInferenceEdgeOutput,
  type GetReasoningContextInput,
  type GetReasoningContextOutput,
  type GetReasoningSessionInput,
  type GetReasoningSessionOutput,
  type GetReasoningTextForVertexInput,
  type GetReasoningTextForVertexOutput,
  type IncreaseReasoningSessionEdgeBudgetInput,
  type IncreaseReasoningSessionEdgeBudgetOutput,
  type GetVertexInput,
  type GetVertexOutput,
  type GraphAliases,
  type GraphRevision,
  type GraphSnapshot,
  type InferenceEdge,
  type InferenceEdgeQuestionInput,
  type LeaseId,
  type ListCandidateEdgesInput,
  type ListCandidateEdgesOutput,
  type ListReasoningSessionsInput,
  type ListReasoningSessionsOutput,
  type Logger,
  type ProposeInferenceEdgeInput,
  type ProposeInferenceEdgeOutput,
  type ProjectionPolicy,
  type QuestionId,
  type ReasoningSession,
  type ReleaseInferenceEdgeInput,
  type ReleaseInferenceEdgeOutput,
  type Result,
  type SearchStrategy,
  type SessionId,
  type UpdateReasoningSessionMetadataInput,
  type UpdateReasoningSessionMetadataOutput,
  type UpdateInferenceEdgeInput,
  type UpdateInferenceEdgeOutput,
  type UpdateVertexInput,
  type UpdateVertexOutput,
  type Vertex,
  type VertexReferenceId,
  type VertexExpansionContext,
  type VertexId,
  type AnswerEvidenceQuestionInput,
  type AnswerEvidenceQuestionOutput,
  TERMINAL_GOAL_STATES,
} from '@reasoner/schema';
import type {
  AuditWriter,
  Clock,
  GraphEventDraft,
  IdGenerator,
  MutationDraft,
  ReasonerRepository,
} from './ports.js';
import { buildGraphIndex, toCompletedIncidenceGraph } from './graph-index.js';
import {
  checkCycleOnComplete,
  validateGraphInvariants,
  type InvariantViolation,
} from './graph-algorithms.js';
import {
  canonicalJson,
  expandedEdgeDedupeKey,
  inferenceFormulaId,
  normalizeText,
  vertexDedupeKey,
} from './dedup.js';
import { orderFrontier } from './search-strategy.js';
import {
  checkLeaseHeld,
  computeExpiry,
  findExpiredLeases,
  grantLease,
  isClaimable,
  reclaimEdge,
  releaseLease,
} from './lease-coordinator.js';
import {
  computeEdgeContextHash,
  projectEdgeContext,
  projectVertexContext,
} from './context-projector.js';
import { renderVertexReasoningContext } from './reasoning-context-renderer.js';
import { assessGoal } from './goal-evaluator.js';

/** Synthetic agent identifier for recovery-time structural checks. */
const RECOVERY_ACTOR = 'system-recovery' as AgentId;

export interface InvalidatedSession {
  readonly sessionId: SessionId;
  readonly violations: readonly InvariantViolation[];
}

export interface RecoveryReport {
  readonly inspectedCount: number;
  readonly invalidated: readonly InvalidatedSession[];
}

export interface ReasonerServiceDeps {
  readonly repository: ReasonerRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditWriter;
  /**
   * Diagnostics sink. A port, not a concrete logger: Core must not depend on
   * pino or any transport. Silent when omitted, so tests stay quiet.
   */
  readonly logger?: Logger;
}

const assertActive = (session: ReasoningSession): Result<ReasoningSession> =>
  TERMINAL_GOAL_STATES.includes(session.goalState)
    ? err('SessionFinished', `session ${session.sessionId} is ${session.goalState}`, {
        goalState: session.goalState,
      })
    : ok(session);

const nextReferenceOrdinal = (referenceIds: readonly string[]): number =>
  referenceIds.reduce((largest, referenceId) => {
    const ordinal = Number(referenceId.slice(1));
    return Number.isSafeInteger(ordinal) && ordinal > largest ? ordinal : largest;
  }, 0);

const nextVertexReferenceId = (vertices: readonly Vertex[]): VertexReferenceId =>
  `V${nextReferenceOrdinal(vertices.map((vertex) => vertex.referenceId)) + 1}` as VertexReferenceId;

const isReservedReferenceId = (value: string, prefix: 'V' | 'E'): boolean =>
  new RegExp(`^${prefix}[1-9][0-9]*$`).test(value);

const sameStringList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Applies a complete question-list replacement while retaining answers for
 * unchanged questions. Answered prompts cannot be removed or rewritten by a
 * manual edit because that would silently change the evidence an Agent gave.
 */
const updateEvidenceQuestions = (
  existing: readonly EvidenceQuestion[],
  requested: readonly InferenceEdgeQuestionInput[],
  ids: IdGenerator,
): Result<readonly EvidenceQuestion[]> => {
  const byId = new Map(existing.map((question) => [question.questionId, question]));
  const byPrompt = new Map(existing.map((question) => [normalizeText(question.prompt), question]));
  const seenIds = new Set<string>();
  const seenPrompts = new Set<string>();
  const next: EvidenceQuestion[] = [];

  for (const request of requested) {
    const normalizedPrompt = normalizeText(request.prompt);
    if (seenPrompts.has(normalizedPrompt)) {
      return err('InvalidInput', 'an edge cannot contain duplicate evidence question prompts', {
        prompt: request.prompt,
      });
    }

    const matched =
      (request.questionId === undefined ? undefined : byId.get(request.questionId)) ??
      byPrompt.get(normalizedPrompt);
    const questionId = matched?.questionId ?? request.questionId ?? ids.newId('question');
    if (seenIds.has(questionId)) {
      return err('InvalidInput', 'an edge cannot contain duplicate evidence question ids', {
        questionId,
      });
    }
    if (matched?.answer !== undefined && matched.prompt !== request.prompt) {
      return err(
        'InvalidInput',
        `answered evidence question ${matched.questionId} cannot be rewritten`,
        { questionId: matched.questionId },
      );
    }

    seenIds.add(questionId);
    seenPrompts.add(normalizedPrompt);
    next.push(
      matched === undefined
        ? { questionId: questionId as EvidenceQuestion['questionId'], prompt: request.prompt }
        : { ...matched, prompt: request.prompt },
    );
  }

  const removedAnswered = existing.find(
    (question) => question.answer !== undefined && !seenIds.has(question.questionId),
  );
  if (removedAnswered !== undefined) {
    return err(
      'InvalidInput',
      `answered evidence question ${removedAnswered.questionId} cannot be removed`,
      { questionId: removedAnswered.questionId },
    );
  }
  return ok(next);
};

interface EdgeEndpoints {
  readonly sourceVertexId: VertexId;
  readonly targetVertexId: VertexId;
}

/** Preserves caller order while preventing duplicate arrows in one proposal. */
const expandEdgeEndpoints = (
  sourceVertexIds: readonly VertexId[],
  targetVertexIds: readonly VertexId[],
): readonly EdgeEndpoints[] => {
  const sources = [...new Set(sourceVertexIds)];
  const targets = [...new Set(targetVertexIds)];
  const endpoints: EdgeEndpoints[] = [];
  for (const sourceVertexId of sources) {
    for (const targetVertexId of targets) endpoints.push({ sourceVertexId, targetVertexId });
  }
  return endpoints;
};

/**
 * Application service behind every MCP tool. All graph mutation flows through
 * `repository.mutate`, whose planner runs inside the write transaction — so
 * validation, cycle checking and the write itself cannot be separated.
 */
export class ReasonerService {
  private readonly log: Logger;

  constructor(private readonly deps: ReasonerServiceDeps) {
    this.log = (deps.logger ?? NULL_LOGGER).child({ component: 'core' });
  }

  async createReasoningSession(
    input: CreateReasoningSessionInput,
  ): Promise<Result<CreateReasoningSessionOutput>> {
    const now = this.deps.clock.now();
    const sessionId = (input.sessionId ?? this.deps.ids.newId('session')) as SessionId;
    const goalVertexId = this.deps.ids.newId('vertex') as VertexId;
    const initialRevision = 1 as GraphRevision;
    const tags = input.tags ?? [];

    const goalVertex: Vertex = {
      vertexId: goalVertexId,
      referenceId: 'V1' as VertexReferenceId,
      kind: 'Goal',
      label: input.goalLabel,
      payload: input.goalPayload,
      dedupeKey: vertexDedupeKey('Goal', input.goalLabel, undefined),
      createdByAgentId: input.agentId,
      createdAt: now,
      createdAtRevision: initialRevision,
    };

    const session: ReasoningSession = {
      sessionId,
      alias: input.alias,
      tags: [...tags],
      goalVertexId,
      goalState: 'Exploring',
      strategy: input.strategy,
      projectionPolicy: input.projectionPolicy,
      budget: {
        maxEdges: input.budget?.maxEdges ?? 2_000,
        maxDepth: input.budget?.maxDepth ?? 64,
        maxLeaseSeconds: input.budget?.maxLeaseSeconds ?? 900,
      },
      graphRevision: initialRevision,
      lastEventSeq: 0,
      createdByAgentId: input.agentId,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.deps.repository.createSession({
      session,
      goalVertex,
      events: [
        {
          kind: 'SessionCreated',
          actorAgentId: input.agentId,
          detail: {
            goalLabel: input.goalLabel,
            alias: input.alias ?? null,
            tags,
          },
        },
        { kind: 'VertexAdded', actorAgentId: input.agentId, vertexId: goalVertexId },
      ],
    });
    if (isErr(created)) return created;

    await this.flushAudit(sessionId, created.value.lastEventSeq);
    return ok({ session: { ...session, lastEventSeq: created.value.lastEventSeq }, goalVertex });
  }

  async getReasoningSession(
    input: GetReasoningSessionInput,
  ): Promise<Result<GetReasoningSessionOutput>> {
    const session = await this.deps.repository.getSession(input.sessionId);
    return isErr(session) ? session : ok({ session: session.value });
  }

  /** Replaces the session's human-facing metadata without changing graph entities or Vn/En. */
  async updateReasoningSessionMetadata(
    input: UpdateReasoningSessionMetadataInput,
  ): Promise<Result<UpdateReasoningSessionMetadataOutput>> {
    let changed = false;
    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot) => {
        const alias = input.alias ?? undefined;
        const aliasChanged = snapshot.session.alias !== alias;
        const tagsChanged = !sameStringList(snapshot.session.tags, input.tags);
        if (!aliasChanged && !tagsChanged) return ok<MutationDraft>({ events: [] });

        changed = true;
        return ok<MutationDraft>({
          sessionPatch: { alias: input.alias, tags: [...input.tags] },
          events: [
            {
              kind: 'SessionMetadataUpdated',
              actorAgentId: input.agentId,
              detail: { alias: alias ?? null, tags: input.tags },
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;

    if (changed) await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      session: outcome.value.snapshot.session,
    });
  }

  /** Deletes the SQLite session graph after a caller-confirmed revision compare-and-set. */
  async deleteReasoningSession(
    input: DeleteReasoningSessionInput,
  ): Promise<Result<DeleteReasoningSessionOutput>> {
    const deleted = await this.deps.repository.deleteSession(
      input.sessionId,
      input.baseGraphRevision,
    );
    if (isErr(deleted)) return deleted;

    // JSONL is append-only, so historical audit files intentionally remain available.
    this.log.info({ sessionId: input.sessionId, actorAgentId: input.agentId }, 'session deleted');
    return ok({ sessionId: input.sessionId, deleted: true });
  }

  /** Raises an active session's physical-edge budget without changing other limits. */
  async increaseReasoningSessionEdgeBudget(
    input: IncreaseReasoningSessionEdgeBudgetInput,
  ): Promise<Result<IncreaseReasoningSessionEdgeBudgetOutput>> {
    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const fromMaxEdges = snapshot.session.budget.maxEdges;
        if (input.maxEdges <= fromMaxEdges) {
          return err('InvalidInput', `maxEdges must increase from ${fromMaxEdges}`, {
            fromMaxEdges,
            requestedMaxEdges: input.maxEdges,
          });
        }
        if (input.maxEdges < snapshot.edges.length) {
          return err(
            'InvalidInput',
            `maxEdges ${input.maxEdges} cannot be below the ${snapshot.edges.length} existing edges`,
            { existingEdgeCount: snapshot.edges.length, requestedMaxEdges: input.maxEdges },
          );
        }

        return ok<MutationDraft>({
          sessionPatch: {
            budget: { ...snapshot.session.budget, maxEdges: input.maxEdges },
          },
          events: [
            {
              kind: 'SessionEdgeBudgetIncreased',
              actorAgentId: input.agentId,
              detail: { fromMaxEdges, toMaxEdges: input.maxEdges },
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      session: outcome.value.snapshot.session,
    });
  }

  /** Returns the authoritative session-local Vn/En reference map. */
  async getGraphAliases(sessionId: SessionId): Promise<Result<GraphAliases>> {
    const snapshot = await this.deps.repository.getSnapshot(sessionId);
    return isErr(snapshot) ? snapshot : ok(buildGraphAliases(snapshot.value));
  }

  async listReasoningSessions(
    input: ListReasoningSessionsInput,
  ): Promise<Result<ListReasoningSessionsOutput>> {
    const sessions = await this.deps.repository.listSessions({
      includeFinished: input.includeFinished,
      limit: input.limit,
    });
    return isErr(sessions) ? sessions : ok({ sessions: [...sessions.value] });
  }

  /** Terminates a session and derives Abandoned for every unfinished edge. */
  async finishReasoningSession(
    input: FinishReasoningSessionInput,
  ): Promise<Result<FinishReasoningSessionOutput>> {
    const abandoned: EdgeId[] = [];

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const events: GraphEventDraft[] = [];
        const upsertEdges: InferenceEdge[] = [];
        for (const edge of snapshot.edges) {
          if (edge.state !== 'Candidate' && edge.state !== 'Leased') continue;
          const { lease: _lease, ...rest } = edge;
          upsertEdges.push({ ...rest, state: 'Abandoned' });
          abandoned.push(edge.edgeId);
          events.push({
            kind: 'EdgeAbandoned',
            actorAgentId: input.agentId,
            edgeId: edge.edgeId,
            detail: { previousState: edge.state },
          });
        }

        events.push({
          kind: 'GoalStateChanged',
          actorAgentId: input.agentId,
          detail: { from: snapshot.session.goalState, to: input.goalState },
        });
        events.push({
          kind: 'SessionFinished',
          actorAgentId: input.agentId,
          detail: { reason: input.reason },
        });

        return ok<MutationDraft>({
          upsertEdges,
          sessionPatch: { goalState: input.goalState, finishedReason: input.reason },
          events,
        });
      },
    );
    if (isErr(outcome)) return outcome;

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      session: outcome.value.snapshot.session,
      abandonedEdgeIds: abandoned,
    });
  }

  async addStateVertex(input: AddStateVertexInput): Promise<Result<AddStateVertexOutput>> {
    return this.addVertex(input, 'State');
  }

  async addEvidenceVertex(input: AddEvidenceVertexInput): Promise<Result<AddEvidenceVertexOutput>> {
    return this.addVertex(input, 'Evidence');
  }

  private async addVertex(
    input: AddStateVertexInput,
    kind: 'State' | 'Evidence',
  ): Promise<Result<AddStateVertexOutput>> {
    let resolved: Vertex | null = null;
    let deduplicated = false;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const dedupeKey = vertexDedupeKey(kind, input.label, input.dedupeKey);
        const existing = snapshot.vertices.find((vertex) => vertex.dedupeKey === dedupeKey);
        if (existing !== undefined) {
          resolved = existing;
          deduplicated = true;
          // Idempotent re-submission: no state change, so no event either.
          return ok<MutationDraft>({ events: [] });
        }

        if (input.vertexId !== undefined && isReservedReferenceId(input.vertexId, 'V')) {
          return err(
            'InvalidInput',
            `${input.vertexId} is reserved for the session vertex reference`,
            {
              vertexId: input.vertexId,
            },
          );
        }

        const vertexId = (input.vertexId ?? this.deps.ids.newId('vertex')) as VertexId;
        if (snapshot.vertices.some((vertex) => vertex.vertexId === vertexId)) {
          return err('DuplicateEntity', `vertex ${vertexId} already exists`, { vertexId });
        }

        const vertex: Vertex = {
          vertexId,
          referenceId: nextVertexReferenceId(snapshot.vertices),
          kind,
          label: input.label,
          payload: input.payload,
          dedupeKey,
          createdByAgentId: input.agentId,
          createdAt: now,
          createdAtRevision: snapshot.graphRevision,
        };
        resolved = vertex;

        return ok<MutationDraft>({
          upsertVertices: [vertex],
          events: [{ kind: 'VertexAdded', actorAgentId: input.agentId, vertexId }],
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (resolved === null) {
      return err('StorageFailure', 'vertex planner did not produce a vertex');
    }

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      vertex: resolved,
      deduplicated,
    });
  }

  async getVertex(input: GetVertexInput): Promise<Result<GetVertexOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;
    const index = buildGraphIndex(snapshot.value);
    const vertex = index.vertexById.get(input.vertexId);
    if (vertex === undefined) {
      return err('VertexNotFound', `vertex ${input.vertexId} not found`, {
        vertexId: input.vertexId,
      });
    }
    return ok({
      vertex,
      incomingEdgeIds: [...(index.incomingEdgeIds.get(input.vertexId) ?? [])],
      outgoingEdgeIds: [...(index.outgoingEdgeIds.get(input.vertexId) ?? [])],
    });
  }

  /** Manually updates a vertex label and/or payload without changing Vn or kind. */
  async updateVertex(input: UpdateVertexInput): Promise<Result<UpdateVertexOutput>> {
    let updated: Vertex | null = null;
    let changed = false;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const vertex = snapshot.vertices.find((candidate) => candidate.vertexId === input.vertexId);
        if (vertex === undefined) {
          return err('VertexNotFound', `vertex ${input.vertexId} not found`, {
            vertexId: input.vertexId,
          });
        }

        const leasedRelation = snapshot.edges.find(
          (edge) =>
            edge.state === 'Leased' &&
            (edge.sourceVertexIds.includes(input.vertexId) ||
              edge.targetVertexIds.includes(input.vertexId)),
        );
        if (leasedRelation !== undefined) {
          return err(
            'InvalidInput',
            `vertex ${input.vertexId} participates in leased edge ${leasedRelation.edgeId}; release it before editing`,
            { vertexId: input.vertexId, edgeId: leasedRelation.edgeId },
          );
        }

        const next: Vertex = {
          ...vertex,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        };
        const labelChanged = next.label !== vertex.label;
        const payloadChanged = canonicalJson(next.payload) !== canonicalJson(vertex.payload);
        if (!labelChanged && !payloadChanged) {
          updated = vertex;
          return ok<MutationDraft>({ events: [] });
        }

        changed = true;
        updated = next;
        return ok<MutationDraft>({
          upsertVertices: [next],
          events: [
            {
              kind: 'VertexUpdated',
              actorAgentId: input.agentId,
              vertexId: input.vertexId,
              detail: {
                fields: [
                  ...(labelChanged ? ['label'] : []),
                  ...(payloadChanged ? ['payload'] : []),
                ],
                editedAt: now,
              },
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (updated === null) return err('StorageFailure', 'vertex update planner produced no vertex');

    if (changed) await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    const persisted = outcome.value.snapshot.vertices.find(
      (vertex) => vertex.vertexId === input.vertexId,
    );
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      vertex: persisted ?? updated,
    });
  }

  async proposeInferenceEdge(
    input: ProposeInferenceEdgeInput,
  ): Promise<Result<ProposeInferenceEdgeOutput>> {
    let resolved: readonly InferenceEdge[] = [];
    let deduplicated = false;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const endpoints = expandEdgeEndpoints(input.sourceVertexIds, input.targetVertexIds);
        if (endpoints.length === 0) {
          return err('InvalidInput', 'at least one source and target vertex are required');
        }

        const index = buildGraphIndex(snapshot);
        for (const sourceId of new Set(input.sourceVertexIds)) {
          if (!index.vertexById.has(sourceId)) {
            return err('VertexNotFound', `source vertex ${sourceId} not found`, {
              vertexId: sourceId,
            });
          }
        }
        for (const targetId of new Set(input.targetVertexIds)) {
          if (!index.vertexById.has(targetId)) {
            return err('VertexNotFound', `target vertex ${targetId} not found`, {
              vertexId: targetId,
            });
          }
        }
        for (const { sourceVertexId, targetVertexId } of endpoints) {
          if (sourceVertexId === targetVertexId) {
            return err('CycleDetected', 'an inference edge cannot target its own source vertex', {
              sourceVertexId,
              targetVertexId,
            });
          }
        }

        if (input.edgeId !== undefined && endpoints.length > 1) {
          return err(
            'InvalidInput',
            'edgeId can only be supplied when a proposal expands to exactly one inference edge',
            { edgeId: input.edgeId, expandedEdgeCount: endpoints.length },
          );
        }

        if (input.edgeId !== undefined && isReservedReferenceId(input.edgeId, 'E')) {
          return err('InvalidInput', `${input.edgeId} is reserved for the session edge reference`, {
            edgeId: input.edgeId,
          });
        }

        const expandsMultipleEdges = endpoints.length > 1;
        const existingByDedupeKey = new Map(
          snapshot.edges
            .filter((edge) => edge.dedupeKey !== undefined)
            .map((edge) => [edge.dedupeKey as string, edge]),
        );
        const candidates = endpoints.map((endpoint) => ({
          endpoints: endpoint,
          formulaId: inferenceFormulaId(
            input.sourceVertexIds,
            endpoint.targetVertexId,
            input.label,
            input.dedupeKey,
          ),
          dedupeKey: expandedEdgeDedupeKey(
            endpoint.sourceVertexId,
            endpoint.targetVertexId,
            input.label,
            input.dedupeKey,
            expandsMultipleEdges,
          ),
        }));
        const formulaConflict = candidates.find((candidate) => {
          const existing = existingByDedupeKey.get(candidate.dedupeKey);
          return existing !== undefined && existing.formulaId !== candidate.formulaId;
        });
        if (formulaConflict !== undefined) {
          const existing = existingByDedupeKey.get(formulaConflict.dedupeKey);
          return err(
            'InvalidInput',
            'an existing direct edge belongs to a different inference formula; use a distinct dedupeKey for the new formula',
            {
              sourceVertexId: formulaConflict.endpoints.sourceVertexId,
              targetVertexId: formulaConflict.endpoints.targetVertexId,
              existingFormulaId: existing?.formulaId,
              requestedFormulaId: formulaConflict.formulaId,
            },
          );
        }
        const pending = candidates.filter(
          (candidate) => !existingByDedupeKey.has(candidate.dedupeKey),
        );

        if (snapshot.edges.length + pending.length > snapshot.session.budget.maxEdges) {
          return err(
            'BudgetExceeded',
            `session reached maxEdges ${snapshot.session.budget.maxEdges}`,
            {
              maxEdges: snapshot.session.budget.maxEdges,
              requestedNewEdges: pending.length,
            },
          );
        }

        if (
          input.edgeId !== undefined &&
          pending.length > 0 &&
          snapshot.edges.some((edge) => edge.edgeId === input.edgeId)
        ) {
          return err('DuplicateEntity', `edge ${input.edgeId} already exists`, {
            edgeId: input.edgeId,
          });
        }

        const created: InferenceEdge[] = [];
        const occupiedEdgeIds = new Set(snapshot.edges.map((edge) => edge.edgeId));
        let referenceOrdinal = nextReferenceOrdinal(snapshot.edges.map((edge) => edge.referenceId));
        for (const [pendingIndex, entry] of pending.entries()) {
          const edgeId = (
            pendingIndex === 0 && input.edgeId !== undefined
              ? input.edgeId
              : this.deps.ids.newId('edge')
          ) as EdgeId;
          if (occupiedEdgeIds.has(edgeId)) {
            return err('DuplicateEntity', `edge ${edgeId} already exists`, { edgeId });
          }
          occupiedEdgeIds.add(edgeId);
          referenceOrdinal += 1;
          const edge: InferenceEdge = {
            edgeId,
            referenceId: `E${referenceOrdinal}` as EdgeReferenceId,
            formulaId: entry.formulaId,
            sourceVertexIds: [entry.endpoints.sourceVertexId],
            targetVertexIds: [entry.endpoints.targetVertexId],
            label: input.label,
            state: 'Candidate',
            cost: input.cost,
            priority: input.priority,
            evidenceQuestions: input.evidenceQuestions.map((question) => ({
              questionId: (question.questionId ?? this.deps.ids.newId('question')) as QuestionId,
              prompt: question.prompt,
            })),
            dedupeKey: entry.dedupeKey,
            proposedByAgentId: input.agentId,
            createdAt: now,
            createdAtRevision: snapshot.graphRevision,
            updatedAtRevision: snapshot.graphRevision,
          };
          created.push(edge);
        }

        const createdByDedupeKey = new Map(created.map((edge) => [edge.dedupeKey as string, edge]));
        resolved = candidates.flatMap((candidate) => {
          const edge =
            existingByDedupeKey.get(candidate.dedupeKey) ??
            createdByDedupeKey.get(candidate.dedupeKey);
          return edge === undefined ? [] : [edge];
        });
        deduplicated = created.length === 0;

        return ok<MutationDraft>({
          upsertEdges: created,
          events: created.map((edge) => ({
            kind: 'EdgeProposed' as const,
            actorAgentId: input.agentId,
            edgeId: edge.edgeId,
          })),
        });
      },
    );
    if (isErr(outcome)) return outcome;
    const firstEdge = resolved[0];
    if (firstEdge === undefined)
      return err('StorageFailure', 'edge planner did not produce an edge');

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      edge: firstEdge,
      edges: [...resolved],
      deduplicated,
    });
  }

  async getInferenceEdge(input: GetInferenceEdgeInput): Promise<Result<GetInferenceEdgeOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;
    const edge = snapshot.value.edges.find((candidate) => candidate.edgeId === input.edgeId);
    return edge === undefined
      ? err('EdgeNotFound', `edge ${input.edgeId} not found`, { edgeId: input.edgeId })
      : ok({ edge });
  }

  /**
   * Manually updates edge presentation/scheduling attributes. The relation's
   * endpoints, formula group, En reference and lifecycle state remain stable.
   */
  async updateInferenceEdge(
    input: UpdateInferenceEdgeInput,
  ): Promise<Result<UpdateInferenceEdgeOutput>> {
    let updated: InferenceEdge | null = null;
    let changed = false;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const edge = snapshot.edges.find((candidate) => candidate.edgeId === input.edgeId);
        if (edge === undefined) {
          return err('EdgeNotFound', `edge ${input.edgeId} not found`, { edgeId: input.edgeId });
        }
        if (edge.state === 'Leased') {
          return err('InvalidInput', `edge ${input.edgeId} is leased; release it before editing`, {
            edgeId: input.edgeId,
          });
        }
        if (input.evidenceQuestions !== undefined && edge.state !== 'Candidate') {
          return err(
            'InvalidInput',
            `evidence questions can only be edited while edge ${input.edgeId} is Candidate`,
            { edgeId: input.edgeId, state: edge.state },
          );
        }

        let nextQuestions = edge.evidenceQuestions;
        if (input.evidenceQuestions !== undefined) {
          const questionResult = updateEvidenceQuestions(
            edge.evidenceQuestions,
            input.evidenceQuestions,
            this.deps.ids,
          );
          if (isErr(questionResult)) return questionResult;
          nextQuestions = [...questionResult.value];
        }

        const next: InferenceEdge = {
          ...edge,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.cost === undefined ? {} : { cost: input.cost }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.evidenceQuestions === undefined ? {} : { evidenceQuestions: nextQuestions }),
        };
        const labelChanged = next.label !== edge.label;
        const costChanged = next.cost !== edge.cost;
        const priorityChanged = next.priority !== edge.priority;
        const questionsChanged =
          canonicalJson(next.evidenceQuestions) !== canonicalJson(edge.evidenceQuestions);
        if (!labelChanged && !costChanged && !priorityChanged && !questionsChanged) {
          updated = edge;
          return ok<MutationDraft>({ events: [] });
        }

        changed = true;
        updated = next;
        return ok<MutationDraft>({
          upsertEdges: [next],
          events: [
            {
              kind: 'EdgeUpdated',
              actorAgentId: input.agentId,
              edgeId: input.edgeId,
              detail: {
                fields: [
                  ...(labelChanged ? ['label'] : []),
                  ...(costChanged ? ['cost'] : []),
                  ...(priorityChanged ? ['priority'] : []),
                  ...(questionsChanged ? ['evidenceQuestions'] : []),
                ],
                editedAt: now,
              },
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (updated === null) return err('StorageFailure', 'edge update planner produced no edge');

    if (changed) await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    const persisted = outcome.value.snapshot.edges.find((edge) => edge.edgeId === input.edgeId);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      edge: persisted ?? updated,
    });
  }

  async listCandidateEdges(
    input: ListCandidateEdgesInput,
  ): Promise<Result<ListCandidateEdgesOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;
    const index = buildGraphIndex(snapshot.value);
    const strategy = input.strategy ?? snapshot.value.session.strategy;
    const ordered = orderFrontier(index, strategy).slice(0, input.limit);
    const edges = ordered
      .map((entry) => index.edgeById.get(entry.edgeId))
      .filter((edge): edge is InferenceEdge => edge !== undefined);
    return ok({ edges, graphRevision: snapshot.value.graphRevision });
  }

  async claimInferenceEdge(
    input: ClaimInferenceEdgeInput,
  ): Promise<Result<ClaimInferenceEdgeOutput>> {
    const result = await this.claimEdgesInternal(
      input.sessionId,
      input.baseGraphRevision,
      input.agentId,
      input.leaseSeconds,
      { mode: 'explicit', edgeId: input.edgeId },
    );
    if (isErr(result)) return result;
    const first = result.value.claims[0];
    if (first === undefined) {
      return err('EdgeNotClaimable', `edge ${input.edgeId} is not claimable`, {
        edgeId: input.edgeId,
      });
    }
    return ok({
      graphRevision: result.value.graphRevision,
      lastEventSeq: result.value.lastEventSeq,
      leaseId: first.leaseId,
      edge: first.edge,
      context: first.context,
    });
  }

  async claimInferenceEdges(
    input: ClaimInferenceEdgesInput,
  ): Promise<Result<ClaimInferenceEdgesOutput>> {
    return this.claimEdgesInternal(
      input.sessionId,
      input.baseGraphRevision,
      input.agentId,
      input.leaseSeconds,
      {
        mode: 'strategy',
        maxEdges: input.maxEdges,
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      },
    );
  }

  /**
   * Single claim path for both tools.
   *
   * Expired-lease reclamation happens in the SAME transaction and the SAME
   * revision bump as the claim itself. Splitting them would bump the revision
   * first and guarantee a RevisionConflict for the caller that triggered the
   * cleanup.
   */
  private async claimEdgesInternal(
    sessionId: SessionId,
    baseGraphRevision: GraphRevision,
    agentId: AgentId,
    leaseSeconds: number | undefined,
    selector:
      | { mode: 'explicit'; edgeId: EdgeId }
      | {
          mode: 'strategy';
          maxEdges: number;
          strategy?: SearchStrategy;
        },
  ): Promise<Result<ClaimInferenceEdgesOutput>> {
    const claimedEdgeIds: EdgeId[] = [];
    const leaseByEdge = new Map<EdgeId, LeaseId>();

    const outcome = await this.deps.repository.mutate(
      sessionId,
      baseGraphRevision,
      (snapshot, now) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const events: GraphEventDraft[] = [];
        const upsertEdges: InferenceEdge[] = [];

        // 1. Reclaim expired leases first, in this same transaction.
        const expired = findExpiredLeases(snapshot.edges, now);
        const reclaimedIds = new Set<EdgeId>();
        for (const edge of expired) {
          upsertEdges.push(reclaimEdge(edge));
          reclaimedIds.add(edge.edgeId);
          events.push({
            kind: 'EdgeLeaseExpired',
            actorAgentId: agentId,
            edgeId: edge.edgeId,
            detail: { previousAgentId: edge.lease?.agentId ?? null },
          });
        }
        if (expired.length > 0) {
          // Makes "my edge was taken away" traceable to the reclaiming claim.
          this.log.info(
            {
              sessionId,
              claimingAgentId: agentId,
              reclaimed: expired.map((edge) => ({
                edgeId: edge.edgeId,
                previousAgentId: edge.lease?.agentId ?? null,
                expiresAt: edge.lease?.expiresAt ?? null,
              })),
            },
            'reclaimed expired leases in claim transaction',
          );
        }

        // 2. Work against the post-reclaim view of the graph.
        const effectiveEdges = snapshot.edges.map((edge) =>
          reclaimedIds.has(edge.edgeId) ? reclaimEdge(edge) : edge,
        );
        const effectiveSnapshot: GraphSnapshot = { ...snapshot, edges: effectiveEdges };

        let targets: InferenceEdge[];
        if (selector.mode === 'explicit') {
          const edge = effectiveEdges.find((candidate) => candidate.edgeId === selector.edgeId);
          if (edge === undefined) {
            return err('EdgeNotFound', `edge ${selector.edgeId} not found`, {
              edgeId: selector.edgeId,
            });
          }
          if (!isClaimable(edge, now)) {
            return err('EdgeNotClaimable', `edge ${selector.edgeId} is ${edge.state}`, {
              edgeId: selector.edgeId,
              state: edge.state,
            });
          }
          targets = [edge];
        } else {
          const index = buildGraphIndex(effectiveSnapshot);
          const strategy = selector.strategy ?? snapshot.session.strategy;
          targets = orderFrontier(index, strategy)
            .slice(0, selector.maxEdges)
            .map((entry) => index.edgeById.get(entry.edgeId))
            .filter((edge): edge is InferenceEdge => edge !== undefined);
        }

        const seconds = Math.min(
          leaseSeconds ?? snapshot.session.budget.maxLeaseSeconds,
          snapshot.session.budget.maxLeaseSeconds,
        );

        for (const edge of targets) {
          const sourceVertices = edge.sourceVertexIds
            .map((id) => effectiveSnapshot.vertices.find((vertex) => vertex.vertexId === id))
            .filter((vertex): vertex is Vertex => vertex !== undefined);

          const leaseId = this.deps.ids.newId('lease') as LeaseId;
          const granted = grantLease(edge, {
            leaseId,
            agentId,
            acquiredAt: now,
            expiresAt: computeExpiry(now, seconds),
            // Archived hash: what complete_inference_edge will be compared against.
            inputContextHash: computeEdgeContextHash(edge, sourceVertices),
          });
          upsertEdges.push(granted);
          claimedEdgeIds.push(edge.edgeId);
          leaseByEdge.set(edge.edgeId, leaseId);
          events.push({
            kind: 'EdgeClaimed',
            actorAgentId: agentId,
            edgeId: edge.edgeId,
            detail: { leaseId },
          });
        }

        return ok<MutationDraft>({ upsertEdges, events });
      },
    );
    if (isErr(outcome)) return outcome;

    await this.flushAudit(sessionId, outcome.value.lastEventSeq);

    const claims: ClaimInferenceEdgesOutput['claims'] = [];
    for (const edgeId of claimedEdgeIds) {
      const edge = outcome.value.snapshot.edges.find((candidate) => candidate.edgeId === edgeId);
      const leaseId = leaseByEdge.get(edgeId);
      if (edge === undefined || leaseId === undefined) continue;
      const context = projectEdgeContext(
        outcome.value.snapshot,
        edgeId,
        outcome.value.snapshot.session.projectionPolicy,
      );
      if (isErr(context)) return context;
      await this.archiveEdgeProjection(outcome.value.snapshot, edgeId, context.value);
      claims.push({ leaseId, edge, context: context.value });
    }

    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      claims,
    });
  }

  async releaseInferenceEdge(
    input: ReleaseInferenceEdgeInput,
  ): Promise<Result<ReleaseInferenceEdgeOutput>> {
    let released: InferenceEdge | null = null;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const edge = snapshot.edges.find((candidate) => candidate.edgeId === input.edgeId);
        if (edge === undefined) {
          return err('EdgeNotFound', `edge ${input.edgeId} not found`, { edgeId: input.edgeId });
        }
        const held = checkLeaseHeld(edge, input.leaseId, input.agentId, now);
        if (!held.ok) return err(held.reason, held.message, { edgeId: input.edgeId });

        const next = releaseLease(edge);
        released = next;
        return ok<MutationDraft>({
          upsertEdges: [next],
          events: [
            {
              kind: 'EdgeLeaseReleased',
              actorAgentId: input.agentId,
              edgeId: input.edgeId,
              ...(input.reason === undefined ? {} : { detail: { reason: input.reason } }),
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (released === null) return err('StorageFailure', 'release planner produced no edge');

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      edge: released,
    });
  }

  async answerEvidenceQuestion(
    input: AnswerEvidenceQuestionInput,
  ): Promise<Result<AnswerEvidenceQuestionOutput>> {
    let updated: InferenceEdge | null = null;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const edge = snapshot.edges.find((candidate) => candidate.edgeId === input.edgeId);
        if (edge === undefined) {
          return err('EdgeNotFound', `edge ${input.edgeId} not found`, { edgeId: input.edgeId });
        }
        const held = checkLeaseHeld(edge, input.leaseId, input.agentId, now);
        if (!held.ok) return err(held.reason, held.message, { edgeId: input.edgeId });

        const question = edge.evidenceQuestions.find(
          (candidate) => candidate.questionId === input.questionId,
        );
        if (question === undefined) {
          return err(
            'QuestionNotFound',
            `question ${input.questionId} not on edge ${input.edgeId}`,
            {
              questionId: input.questionId,
            },
          );
        }

        const next: InferenceEdge = {
          ...edge,
          evidenceQuestions: edge.evidenceQuestions.map((candidate) =>
            candidate.questionId === input.questionId
              ? {
                  ...candidate,
                  answer: input.answer,
                  answeredByAgentId: input.agentId,
                  answeredAt: now,
                  answeredAtRevision: snapshot.graphRevision,
                }
              : candidate,
          ),
          updatedAtRevision: snapshot.graphRevision,
        };
        updated = next;

        return ok<MutationDraft>({
          upsertEdges: [next],
          events: [
            {
              kind: 'EvidenceQuestionAnswered',
              actorAgentId: input.agentId,
              edgeId: input.edgeId,
              detail: { questionId: input.questionId },
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (updated === null) return err('StorageFailure', 'answer planner produced no edge');

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      edge: updated,
    });
  }

  /**
   * Completes a leased edge.
   *
   * The submitted inputContextHash is compared against the hash archived when
   * the lease was granted — never against a freshly computed projection. That
   * archived hash covers only this edge's own material, so another agent
   * advancing an unrelated part of the graph does not invalidate this claim.
   *
   * The cycle check runs inside the write transaction, against the locked
   * snapshot, and a detected cycle aborts before any mutation is recorded.
   */
  async completeInferenceEdge(
    input: CompleteInferenceEdgeInput,
  ): Promise<Result<CompleteInferenceEdgeOutput>> {
    let completed: InferenceEdge | null = null;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const active = assertActive(snapshot.session);
        if (isErr(active)) return active;

        const edge = snapshot.edges.find((candidate) => candidate.edgeId === input.edgeId);
        if (edge === undefined) {
          return err('EdgeNotFound', `edge ${input.edgeId} not found`, { edgeId: input.edgeId });
        }
        const held = checkLeaseHeld(edge, input.leaseId, input.agentId, now);
        if (!held.ok) return err(held.reason, held.message, { edgeId: input.edgeId });

        const archivedHash = edge.lease?.inputContextHash;
        if (archivedHash !== input.inputContextHash) {
          /**
           * T2's invariant, made observable: this compares against the hash
           * archived at claim time, so it can only fire when this edge itself
           * changed. If it ever fires because someone else advanced an
           * unrelated part of the graph, that is the T2 regression and this
           * line is the evidence.
           */
          this.log.warn(
            {
              sessionId: input.sessionId,
              edgeId: input.edgeId,
              agentId: input.agentId,
              archivedHash: archivedHash ?? null,
              submittedHash: input.inputContextHash,
            },
            'edge context stale at completion',
          );
          return err(
            'ContextStale',
            `edge ${input.edgeId} changed since it was claimed; re-read its context and retry`,
            { expected: archivedHash ?? null, received: input.inputContextHash },
          );
        }

        const unanswered = edge.evidenceQuestions.filter(
          (question) => question.answer === undefined,
        );
        if (unanswered.length > 0) {
          return err(
            'InvalidInput',
            `edge ${input.edgeId} has ${unanswered.length} unanswered evidence question(s)`,
            { questionIds: unanswered.map((question) => question.questionId) },
          );
        }

        // Cycle check against the locked snapshot, before any write.
        const completedGraph = toCompletedIncidenceGraph(buildGraphIndex(snapshot));
        const cycle = checkCycleOnComplete(
          completedGraph,
          edge.sourceVertexIds,
          edge.targetVertexIds,
        );
        if (cycle.hasCycle) {
          // The offending sources are what an operator needs to untangle it.
          this.log.warn(
            {
              sessionId: input.sessionId,
              edgeId: input.edgeId,
              agentId: input.agentId,
              targetVertexIds: edge.targetVertexIds,
              offendingSourceIds: cycle.offendingSourceIds,
            },
            'rejected edge completion: would create a cycle',
          );
          return err(
            'CycleDetected',
            `completing edge ${input.edgeId} would create a cycle in the completed subgraph`,
            {
              edgeId: input.edgeId,
              targetVertexIds: edge.targetVertexIds,
              offendingSourceIds: cycle.offendingSourceIds,
            },
          );
        }

        const { lease: _lease, ...rest } = edge;
        const next: InferenceEdge = {
          ...rest,
          state: 'Completed',
          conclusion: input.conclusion,
          updatedAtRevision: snapshot.graphRevision,
        };
        completed = next;

        const events: GraphEventDraft[] = [
          { kind: 'EdgeCompleted', actorAgentId: input.agentId, edgeId: input.edgeId },
        ];

        // Re-assess the goal against the post-completion graph.
        const projected: GraphSnapshot = {
          ...snapshot,
          edges: snapshot.edges.map((candidate) =>
            candidate.edgeId === next.edgeId ? next : candidate,
          ),
        };
        const assessment = assessGoal(projected);

        /**
         * The Core never unilaterally drives a session into a terminal state.
         * An empty frontier only means nothing is queued right now — an agent
         * may still propose further edges — so auto-terminating here would
         * strand a session that is still usable. Terminal states are reached
         * either through finish_reasoning_session or by the caller passing
         * goalState explicitly. A terminal recommendation is downgraded to
         * CandidateFound when the goal is derivable, and otherwise ignored.
         */
        const autoState = TERMINAL_GOAL_STATES.includes(assessment.recommendedGoalState)
          ? assessment.goalSupported
            ? 'CandidateFound'
            : snapshot.session.goalState
          : assessment.recommendedGoalState;
        const desiredGoalState = input.goalState ?? autoState;
        const sessionPatch =
          desiredGoalState === snapshot.session.goalState
            ? undefined
            : { goalState: desiredGoalState };
        if (sessionPatch !== undefined) {
          events.push({
            kind: 'GoalStateChanged',
            actorAgentId: input.agentId,
            detail: {
              from: snapshot.session.goalState,
              to: desiredGoalState,
              rationale: assessment.rationale,
            },
          });
        }

        return ok<MutationDraft>({
          upsertEdges: [next],
          ...(sessionPatch === undefined ? {} : { sessionPatch }),
          events,
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (completed === null) return err('StorageFailure', 'complete planner produced no edge');

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      edge: completed,
      session: outcome.value.snapshot.session,
    });
  }

  async blockInferenceEdge(
    input: BlockInferenceEdgeInput,
  ): Promise<Result<BlockInferenceEdgeOutput>> {
    let blocked: InferenceEdge | null = null;

    const outcome = await this.deps.repository.mutate(
      input.sessionId,
      input.baseGraphRevision,
      (snapshot, now) => {
        const edge = snapshot.edges.find((candidate) => candidate.edgeId === input.edgeId);
        if (edge === undefined) {
          return err('EdgeNotFound', `edge ${input.edgeId} not found`, { edgeId: input.edgeId });
        }
        if (edge.state !== 'Candidate' && edge.state !== 'Leased') {
          return err(
            'InvalidInput',
            `edge ${input.edgeId} is ${edge.state} and cannot be blocked`,
            {
              state: edge.state,
            },
          );
        }
        if (edge.state === 'Leased') {
          if (input.leaseId === undefined) {
            return err('LeaseNotHeld', `edge ${input.edgeId} is leased; a leaseId is required`, {
              edgeId: input.edgeId,
            });
          }
          const held = checkLeaseHeld(edge, input.leaseId, input.agentId, now);
          if (!held.ok) return err(held.reason, held.message, { edgeId: input.edgeId });
        }

        const { lease: _lease, ...rest } = edge;
        const next: InferenceEdge = {
          ...rest,
          state: 'Blocked',
          blockedReason: input.reason,
          updatedAtRevision: snapshot.graphRevision,
        };
        blocked = next;

        return ok<MutationDraft>({
          upsertEdges: [next],
          events: [
            {
              kind: 'EdgeBlocked',
              actorAgentId: input.agentId,
              edgeId: input.edgeId,
              detail: { reason: input.reason },
            },
          ],
        });
      },
    );
    if (isErr(outcome)) return outcome;
    if (blocked === null) return err('StorageFailure', 'block planner produced no edge');

    await this.flushAudit(input.sessionId, outcome.value.lastEventSeq);
    return ok({
      graphRevision: outcome.value.graphRevision,
      lastEventSeq: outcome.value.lastEventSeq,
      edge: blocked,
    });
  }

  async getContextForVertex(
    input: GetContextForVertexInput,
  ): Promise<Result<GetContextForVertexOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;

    const policy = input.policy ?? snapshot.value.session.projectionPolicy;
    const context = projectVertexContext(snapshot.value, input.vertexId, policy);
    if (isErr(context)) return context;

    await this.archiveVertexProjection(snapshot.value, input.vertexId, policy, context.value);

    return ok({ context: context.value });
  }

  /** Renders the same audited vertex projection as Markdown reasoning text and Mermaid. */
  async getReasoningTextForVertex(
    input: GetReasoningTextForVertexInput,
  ): Promise<Result<GetReasoningTextForVertexOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;

    const policy = input.policy ?? snapshot.value.session.projectionPolicy;
    const context = projectVertexContext(snapshot.value, input.vertexId, policy);
    if (isErr(context)) return context;

    await this.archiveVertexProjection(snapshot.value, input.vertexId, policy, context.value);
    return ok({
      context: context.value,
      ...renderVertexReasoningContext(context.value, buildGraphAliases(snapshot.value)),
    });
  }

  async getContextForEdge(input: GetContextForEdgeInput): Promise<Result<GetContextForEdgeOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;

    const policy = input.policy ?? snapshot.value.session.projectionPolicy;
    const context = projectEdgeContext(snapshot.value, input.edgeId, policy);
    if (isErr(context)) return context;

    await this.archiveEdgeProjection(snapshot.value, input.edgeId, context.value);
    return ok({ context: context.value });
  }

  /**
   * Session-level overview. Deliberately returns neither a VertexExpansionContext
   * nor an EdgeExecutionContext, so the three context tools stay distinct.
   */
  async getReasoningContext(
    input: GetReasoningContextInput,
  ): Promise<Result<GetReasoningContextOutput>> {
    const snapshot = await this.deps.repository.getSnapshot(input.sessionId);
    if (isErr(snapshot)) return snapshot;

    const events = await this.deps.repository.listEvents(
      input.sessionId,
      input.afterEventSeq,
      input.eventLimit,
    );
    if (isErr(events)) return events;

    const index = buildGraphIndex(snapshot.value);
    const frontier = orderFrontier(index, snapshot.value.session.strategy);
    const counts: Record<string, number> = {};
    for (const edge of snapshot.value.edges) {
      counts[edge.state] = (counts[edge.state] ?? 0) + 1;
    }

    const last = events.value[events.value.length - 1];
    return ok({
      snapshot: snapshot.value,
      frontierEdgeIds: frontier.map((entry) => entry.edgeId),
      edgeCountByState: counts,
      events: [...events.value],
      nextEventSeq: last === undefined ? input.afterEventSeq : last.eventSeq,
      hasMoreEvents: events.value.length === input.eventLimit,
    });
  }

  private async archiveEdgeProjection(
    snapshot: GraphSnapshot,
    edgeId: EdgeId,
    context: EdgeExecutionContext,
  ): Promise<void> {
    await this.deps.repository.saveContextProjection({
      projectionId: this.deps.ids.newId('projection'),
      sessionId: snapshot.session.sessionId,
      subjectKind: 'Edge',
      subjectId: edgeId,
      policy: context.policy,
      graphRevision: snapshot.graphRevision,
      snapshotHash: snapshot.snapshotHash,
      contextHash: context.contextHash,
      includedVertexIds: [
        ...context.targetVertices.map((vertex) => vertex.vertexId),
        ...context.sourceVertices.map((vertex) => vertex.vertexId),
        ...context.ancestorVertices.map((vertex) => vertex.vertexId),
      ],
      includedEdgeIds: [edgeId, ...context.ancestorEdges.map((edge) => edge.edgeId)],
      omittedVertexIds: context.omittedVertexIds,
      omittedEdgeIds: context.omittedEdgeIds,
      expansionHandles: context.expansionHandles,
      createdAt: this.deps.clock.now(),
    });
  }

  /** Audit-only write: no revision bump and no GraphEvent. */
  private async archiveVertexProjection(
    snapshot: GraphSnapshot,
    vertexId: VertexId,
    policy: ProjectionPolicy,
    context: VertexExpansionContext,
  ): Promise<void> {
    await this.deps.repository.saveContextProjection({
      projectionId: this.deps.ids.newId('projection'),
      sessionId: snapshot.session.sessionId,
      subjectKind: 'Vertex',
      subjectId: vertexId,
      policy,
      graphRevision: snapshot.graphRevision,
      snapshotHash: snapshot.snapshotHash,
      contextHash: context.contextHash,
      includedVertexIds: [
        context.currentVertex.vertexId,
        ...context.ancestorVertices.map((vertex) => vertex.vertexId),
      ],
      includedEdgeIds: context.ancestorEdges.map((edge) => edge.edgeId),
      omittedVertexIds: context.omittedVertexIds,
      omittedEdgeIds: context.omittedEdgeIds,
      expansionHandles: context.expansionHandles,
      createdAt: this.deps.clock.now(),
    });
  }

  /**
   * Startup recovery gate. Every non-terminal session restored from SQLite is
   * re-validated against the graph invariants; a session whose completed
   * subgraph has a self-loop or a strongly connected component larger than one
   * is moved to StructurallyInvalid rather than being scheduled again. A broken
   * graph must never be handed to an agent silently.
   */
  async validateRecoveredSessions(limit = 100): Promise<Result<RecoveryReport>> {
    const sessions = await this.deps.repository.listSessions({
      includeFinished: false,
      limit,
    });
    if (isErr(sessions)) return sessions;

    const invalidated: InvalidatedSession[] = [];

    for (const session of sessions.value) {
      const snapshot = await this.deps.repository.getSnapshot(session.sessionId);
      if (isErr(snapshot)) {
        this.log.error(
          { sessionId: session.sessionId, code: snapshot.error.code },
          'recovery: snapshot unreadable',
        );
        continue;
      }

      const violations = validateGraphInvariants(
        toCompletedIncidenceGraph(buildGraphIndex(snapshot.value)),
      );
      if (violations.length === 0) {
        this.log.debug(
          { sessionId: session.sessionId, graphRevision: snapshot.value.graphRevision },
          'recovery: session invariants hold',
        );
        continue;
      }

      const structuralError = violations
        .map((violation) => `${violation.kind}: ${violation.detail}`)
        .join('; ');

      this.log.error(
        { sessionId: session.sessionId, violations },
        'recovery: structural violation, session marked unschedulable',
      );

      const outcome = await this.deps.repository.mutate(
        session.sessionId,
        snapshot.value.graphRevision,
        () =>
          ok({
            sessionPatch: { goalState: 'StructurallyInvalid' as const, structuralError },
            events: [
              {
                kind: 'StructuralErrorDetected' as const,
                actorAgentId: RECOVERY_ACTOR,
                detail: { violations: [...violations] },
              },
            ],
          }),
      );
      if (isErr(outcome)) {
        this.log.error(
          { sessionId: session.sessionId, code: outcome.error.code },
          'recovery: failed to persist StructurallyInvalid',
        );
        continue;
      }
      invalidated.push({ sessionId: session.sessionId, violations });
    }

    const report: RecoveryReport = {
      inspectedCount: sessions.value.length,
      invalidated,
    };
    this.log.info({ ...report }, 'recovery: invariant validation complete');
    return ok(report);
  }

  /** Mirrors committed events to the JSONL audit log; failures never roll back. */
  private async flushAudit(sessionId: SessionId, throughEventSeq: number): Promise<void> {
    const events = await this.deps.repository.listEvents(sessionId, throughEventSeq - 1, 100);
    if (isErr(events)) return;
    await this.deps.audit.append(sessionId, events.value);
  }
}

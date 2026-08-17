import { z } from 'zod';
import {
  AgentIdSchema,
  EdgeIdSchema,
  EventSeqSchema,
  FormulaIdSchema,
  GraphRevisionSchema,
  LeaseIdSchema,
  QuestionIdSchema,
  SessionIdSchema,
  VertexIdSchema,
} from './ids.js';
import {
  EdgeStateSchema,
  InferenceEdgeSchema,
  VertexExpansionSchema,
  VertexKindSchema,
  VertexSchema,
} from './graph.js';
import {
  GoalStateSchema,
  GraphEventSchema,
  GraphSnapshotSchema,
  ProjectionPolicySchema,
  ReasoningSessionSchema,
  SessionAliasSchema,
  SearchStrategySchema,
  SessionBudgetSchema,
  SessionTagListSchema,
} from './session.js';
import {
  EdgeExecutionContextSchema,
  VertexDownstreamContextSchema,
  VertexExpansionContextSchema,
  VertexReasoningTextSchema,
} from './context.js';

/** Every write command carries caller identity plus the revision it observed. */
const WriteCommandBase = z.object({
  sessionId: SessionIdSchema,
  baseGraphRevision: GraphRevisionSchema,
  agentId: AgentIdSchema,
});

const RevisionAck = z.object({
  graphRevision: GraphRevisionSchema,
  lastEventSeq: EventSeqSchema,
});

// --- 1. create_reasoning_session ---
export const CreateReasoningSessionInputSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  agentId: AgentIdSchema,
  alias: SessionAliasSchema.optional(),
  tags: SessionTagListSchema.optional(),
  goalLabel: z.string().min(1).max(400),
  goalPayload: z.record(z.unknown()).default({}),
  strategy: SearchStrategySchema.default('DFS'),
  projectionPolicy: ProjectionPolicySchema.default('DependencySubgraphWithGlobalSummary'),
  budget: SessionBudgetSchema.partial().optional(),
});
export const CreateReasoningSessionOutputSchema = z.object({
  session: ReasoningSessionSchema,
  goalVertex: VertexSchema,
});

// --- 2. get_reasoning_session ---
export const GetReasoningSessionInputSchema = z.object({ sessionId: SessionIdSchema });
export const GetReasoningSessionOutputSchema = z.object({ session: ReasoningSessionSchema });

// --- 3. update_reasoning_session_metadata ---
/** Replaces the human-facing alias and full tag list without changing Vn/En. */
export const UpdateReasoningSessionMetadataInputSchema = WriteCommandBase.extend({
  /** Use null to clear the alias. */
  alias: SessionAliasSchema.nullable(),
  tags: SessionTagListSchema,
});
export const UpdateReasoningSessionMetadataOutputSchema = RevisionAck.extend({
  session: ReasoningSessionSchema,
});

// --- 4. delete_reasoning_session ---
export const DeleteReasoningSessionInputSchema = WriteCommandBase.extend({
  /** Explicitly required because this physically removes the SQLite session graph. */
  confirm: z.literal(true),
});
export const DeleteReasoningSessionOutputSchema = z.object({
  sessionId: SessionIdSchema,
  deleted: z.literal(true),
});

// --- 5. list_reasoning_sessions ---
export const ListReasoningSessionsInputSchema = z.object({
  includeFinished: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(100),
});
export const ListReasoningSessionsOutputSchema = z.object({
  sessions: z.array(ReasoningSessionSchema),
});

// --- 6. finish_reasoning_session ---
export const FinishReasoningSessionInputSchema = WriteCommandBase.extend({
  goalState: GoalStateSchema,
  reason: z.string().min(1).max(2000),
});
export const FinishReasoningSessionOutputSchema = RevisionAck.extend({
  session: ReasoningSessionSchema,
  /** Candidate/Leased edges transitioned to Abandoned by this call. */
  abandonedEdgeIds: z.array(EdgeIdSchema),
});

// --- 7. increase_reasoning_session_edge_budget ---
export const IncreaseReasoningSessionEdgeBudgetInputSchema = WriteCommandBase.extend({
  /** New absolute limit; it must be greater than the current maxEdges value. */
  maxEdges: z.number().int().positive().max(100_000),
});
export const IncreaseReasoningSessionEdgeBudgetOutputSchema = RevisionAck.extend({
  session: ReasoningSessionSchema,
});

// --- 8. add_state_vertex ---
export const AddStateVertexInputSchema = WriteCommandBase.extend({
  vertexId: VertexIdSchema.optional(),
  label: z.string().min(1).max(400),
  payload: z.record(z.unknown()).default({}),
  dedupeKey: z.string().min(1).max(400).optional(),
});
export const AddStateVertexOutputSchema = RevisionAck.extend({
  vertex: VertexSchema,
  deduplicated: z.boolean(),
});

// --- 9. add_evidence_vertex ---
export const AddEvidenceVertexInputSchema = AddStateVertexInputSchema;
export const AddEvidenceVertexOutputSchema = AddStateVertexOutputSchema;

// --- 10. get_vertex ---
export const GetVertexInputSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
});
export const GetVertexOutputSchema = z.object({
  vertex: VertexSchema,
  incomingEdgeIds: z.array(EdgeIdSchema),
  outgoingEdgeIds: z.array(EdgeIdSchema),
  expansion: VertexExpansionSchema,
});

// --- 11. update_vertex ---
/** Updates editable vertex content while preserving its Vn identity and kind. */
export const UpdateVertexInputSchema = WriteCommandBase.extend({
  vertexId: VertexIdSchema,
  label: z.string().min(1).max(400).optional(),
  payload: z.record(z.unknown()).optional(),
}).refine((input) => input.label !== undefined || input.payload !== undefined, {
  message: 'at least one editable vertex field is required',
});
export const UpdateVertexOutputSchema = RevisionAck.extend({
  vertex: VertexSchema,
});

/** Input shape shared by edge proposal and manual edge editing. */
export const InferenceEdgeQuestionInputSchema = z.object({
  questionId: QuestionIdSchema.optional(),
  prompt: z.string().min(1).max(2000),
});

// --- 12. propose_inference_edge ---
export const ProposeInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema.optional(),
  /**
   * Batch endpoints. The service expands their Cartesian product into
   * independent one-source/one-target inference edges in input order. For
   * each target, all source edges from one proposal form a conjunction.
   */
  sourceVertexIds: z.array(VertexIdSchema).min(1),
  targetVertexIds: z.array(VertexIdSchema).min(1),
  label: z.string().min(1).max(400),
  cost: z.number().finite().nonnegative().default(1),
  priority: z.number().finite().default(0),
  evidenceQuestions: z.array(InferenceEdgeQuestionInputSchema).default([]),
  dedupeKey: z.string().min(1).max(400).optional(),
});
export const ProposeInferenceEdgeOutputSchema = RevisionAck.extend({
  /** First expanded edge, retained for clients that submit one pair. */
  edge: InferenceEdgeSchema,
  /** Every independent edge produced or reused by this proposal, in input order. */
  edges: z.array(InferenceEdgeSchema).min(1),
  deduplicated: z.boolean(),
});

// --- 13. get_inference_edge ---
export const GetInferenceEdgeInputSchema = z.object({
  sessionId: SessionIdSchema,
  edgeId: EdgeIdSchema,
});
export const GetInferenceEdgeOutputSchema = z.object({ edge: InferenceEdgeSchema });

// --- 14. update_inference_edge ---
/**
 * Updates edge presentation and scheduling attributes. Endpoints, formulaId,
 * En, lifecycle state and lease are deliberately immutable through this tool.
 */
export const UpdateInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  label: z.string().min(1).max(400).optional(),
  cost: z.number().finite().nonnegative().optional(),
  priority: z.number().finite().optional(),
  evidenceQuestions: z.array(InferenceEdgeQuestionInputSchema).optional(),
}).refine(
  (input) =>
    input.label !== undefined ||
    input.cost !== undefined ||
    input.priority !== undefined ||
    input.evidenceQuestions !== undefined,
  { message: 'at least one editable edge field is required' },
);
export const UpdateInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 13. list_candidate_edges ---
export const ListCandidateEdgesInputSchema = z.object({
  sessionId: SessionIdSchema,
  strategy: SearchStrategySchema.optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export const ListCandidateEdgesOutputSchema = z.object({
  /** Deterministically ordered by the session (or overridden) strategy. */
  edges: z.array(InferenceEdgeSchema),
  graphRevision: GraphRevisionSchema,
});

// --- 14. claim_vertex_expansions ---
export const ClaimVertexExpansionsInputSchema = WriteCommandBase.extend({
  /** Restrict scheduling to the reverse-dependency subgraph rooted here. */
  rootVertexId: VertexIdSchema.optional(),
  /** Kept batch-shaped so callers can raise parallelism later without a new API. */
  maxVertices: z.number().int().positive().max(50).default(1),
  /** Defaults to the session lease limit and can never exceed it. */
  leaseSeconds: z.number().int().positive().max(86_400).optional(),
  /** Excludes deeper nodes before reservation, avoiding immediately releasable claims. */
  maxDepth: z.number().int().positive().max(1_000).optional(),
});

export const VertexExpansionClaimSchema = z.object({
  leaseId: LeaseIdSchema,
  vertex: VertexSchema,
  expansion: VertexExpansionSchema,
  depth: z.number().int().nonnegative(),
  priority: z.number().finite(),
  /** Position in the service-owned deterministic scheduling order. */
  rank: z.number().int().nonnegative(),
});

export const ClaimVertexExpansionsOutputSchema = RevisionAck.extend({
  sessionId: SessionIdSchema,
  claims: z.array(VertexExpansionClaimSchema),
});

// --- 15. set_vertex_expansion_state ---
export const SettableVertexExpansionStateSchema = z.enum([
  'Pending',
  'AwaitingContext',
  'Expanded',
  'Blocked',
]);
export type SettableVertexExpansionState = z.infer<typeof SettableVertexExpansionStateSchema>;

export const SetVertexExpansionStateInputSchema = WriteCommandBase.extend({
  vertexId: VertexIdSchema,
  leaseId: LeaseIdSchema,
  state: SettableVertexExpansionStateSchema,
  reason: z.string().min(1).max(2000).optional(),
}).superRefine((input, context) => {
  if ((input.state === 'AwaitingContext' || input.state === 'Blocked') && input.reason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reason'],
      message: `${input.state} requires a reason`,
    });
  }
});

export const SetVertexExpansionStateOutputSchema = RevisionAck.extend({
  sessionId: SessionIdSchema,
  vertex: VertexSchema,
  expansion: VertexExpansionSchema,
});

// --- 16. claim_inference_edge ---
export const ClaimInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseSeconds: z.number().int().positive().max(86_400).optional(),
});
export const ClaimInferenceEdgeOutputSchema = RevisionAck.extend({
  leaseId: LeaseIdSchema,
  edge: InferenceEdgeSchema,
  context: EdgeExecutionContextSchema,
});

// --- 17. claim_inference_edges ---
export const ClaimInferenceEdgesInputSchema = WriteCommandBase.extend({
  maxEdges: z.number().int().positive().max(50).default(5),
  strategy: SearchStrategySchema.optional(),
  leaseSeconds: z.number().int().positive().max(86_400).optional(),
});
export const ClaimInferenceEdgesOutputSchema = RevisionAck.extend({
  claims: z.array(
    z.object({
      leaseId: LeaseIdSchema,
      edge: InferenceEdgeSchema,
      context: EdgeExecutionContextSchema,
    }),
  ),
});

// --- 18. release_inference_edge ---
export const ReleaseInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseId: LeaseIdSchema,
  reason: z.string().max(2000).optional(),
});
export const ReleaseInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 19. answer_evidence_question ---
export const AnswerEvidenceQuestionInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  questionId: QuestionIdSchema,
  leaseId: LeaseIdSchema,
  answer: z.string().min(1).max(4000),
});
export const AnswerEvidenceQuestionOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 20. complete_inference_edge ---
export const CompleteInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseId: LeaseIdSchema,
  /** Compared against the archived claim-time projection hash (never recomputed). */
  inputContextHash: z.string().regex(/^[0-9a-f]{64}$/),
  conclusion: z.string().min(1).max(4000),
  goalState: GoalStateSchema.optional(),
});
export const CompleteInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
  session: ReasoningSessionSchema,
});

// --- 21. block_inference_edge ---
export const BlockInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseId: LeaseIdSchema.optional(),
  reason: z.string().min(1).max(2000),
});
export const BlockInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 22. get_context_for_vertex ---
export const GetContextForVertexInputSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
  policy: ProjectionPolicySchema.optional(),
  expansionHandleId: z.string().min(1).max(200).optional(),
});
export const GetContextForVertexOutputSchema = z.object({
  context: VertexExpansionContextSchema,
});

// --- 23. get_downstream_context_for_vertex ---
export const GetDownstreamContextForVertexInputSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
});
export const GetDownstreamContextForVertexOutputSchema = z.object({
  context: VertexDownstreamContextSchema,
});

// --- 24. get_reasoning_text_for_vertex ---
export const GetReasoningTextForVertexInputSchema = GetContextForVertexInputSchema;
export const GetReasoningTextForVertexOutputSchema = VertexReasoningTextSchema;

// --- 25. get_context_for_edge ---
export const GetContextForEdgeInputSchema = z.object({
  sessionId: SessionIdSchema,
  edgeId: EdgeIdSchema,
  policy: ProjectionPolicySchema.optional(),
  expansionHandleId: z.string().min(1).max(200).optional(),
});
export const GetContextForEdgeOutputSchema = z.object({
  context: EdgeExecutionContextSchema,
});

// --- 26. get_reasoning_context ---
/**
 * Session-level read-only overview. It deliberately returns neither a single
 * vertex payload nor a single edge payload; use the entity context tools for those.
 */
export const GetReasoningContextInputSchema = z.object({
  sessionId: SessionIdSchema,
  afterEventSeq: z.number().int().nonnegative().default(0),
  eventLimit: z.number().int().positive().max(1000).default(200),
});

/**
 * Aggregate lifecycle for one logical inference formula. `Blocked` also covers
 * an Abandoned or Invalid component, because an AND formula cannot complete
 * while any one of its physical edges is in one of those terminal states.
 */
export const ReasoningFormulaGroupStateSchema = z.enum([
  'Candidate',
  'Leased',
  'Completed',
  'Blocked',
]);

/**
 * A compact logical formula view over the physical edges in `snapshot.edges`.
 * It intentionally contains ids and aggregate state only: vertex and edge
 * details remain single-sourced in the snapshot.
 */
export const ReasoningFormulaGroupSchema = z.object({
  formulaId: FormulaIdSchema,
  sourceVertexIds: z.array(VertexIdSchema).min(1),
  targetVertexId: VertexIdSchema,
  edgeIds: z.array(EdgeIdSchema).min(1),
  state: ReasoningFormulaGroupStateSchema,
});

/** Structural assessment of the session goal identified by `snapshot.session.goalVertexId`. */
export const ReasoningGoalAssessmentSchema = z.object({
  goalSupported: z.boolean(),
  recommendedGoalState: GoalStateSchema,
  rationale: z.string().min(1).max(2000),
});

/**
 * Derived structural index for machine summary and parsing. Formula operands
 * are AND-related; separate formula groups with the same target are OR-related.
 */
export const ReasoningStructureSchema = z.object({
  schemaVersion: z.literal(1),
  formulaGroups: z.array(ReasoningFormulaGroupSchema),
  goalAssessment: ReasoningGoalAssessmentSchema,
});

export const GetReasoningContextOutputSchema = z.object({
  snapshot: GraphSnapshotSchema,
  reasoningStructure: ReasoningStructureSchema,
  frontierEdgeIds: z.array(EdgeIdSchema),
  /** Pending planning targets in the session-owned DFS/BFS/Priority order. */
  expansionFrontierVertexIds: z.array(VertexIdSchema),
  /** Vertices reserved by an active expansion lease or awaiting its context. */
  activeExpansionVertexIds: z.array(VertexIdSchema),
  edgeCountByState: z.record(EdgeStateSchema, z.number().int().nonnegative()),
  events: z.array(GraphEventSchema),
  nextEventSeq: z.number().int().nonnegative(),
  hasMoreEvents: z.boolean(),
});

export const VertexKindValues = VertexKindSchema.options;

export type CreateReasoningSessionInput = z.infer<typeof CreateReasoningSessionInputSchema>;
export type CreateReasoningSessionOutput = z.infer<typeof CreateReasoningSessionOutputSchema>;
export type GetReasoningSessionInput = z.infer<typeof GetReasoningSessionInputSchema>;
export type GetReasoningSessionOutput = z.infer<typeof GetReasoningSessionOutputSchema>;
export type UpdateReasoningSessionMetadataInput = z.infer<
  typeof UpdateReasoningSessionMetadataInputSchema
>;
export type UpdateReasoningSessionMetadataOutput = z.infer<
  typeof UpdateReasoningSessionMetadataOutputSchema
>;
export type DeleteReasoningSessionInput = z.infer<typeof DeleteReasoningSessionInputSchema>;
export type DeleteReasoningSessionOutput = z.infer<typeof DeleteReasoningSessionOutputSchema>;
export type ListReasoningSessionsInput = z.infer<typeof ListReasoningSessionsInputSchema>;
export type ListReasoningSessionsOutput = z.infer<typeof ListReasoningSessionsOutputSchema>;
export type FinishReasoningSessionInput = z.infer<typeof FinishReasoningSessionInputSchema>;
export type FinishReasoningSessionOutput = z.infer<typeof FinishReasoningSessionOutputSchema>;
export type IncreaseReasoningSessionEdgeBudgetInput = z.infer<
  typeof IncreaseReasoningSessionEdgeBudgetInputSchema
>;
export type IncreaseReasoningSessionEdgeBudgetOutput = z.infer<
  typeof IncreaseReasoningSessionEdgeBudgetOutputSchema
>;
export type AddStateVertexInput = z.infer<typeof AddStateVertexInputSchema>;
export type AddStateVertexOutput = z.infer<typeof AddStateVertexOutputSchema>;
export type AddEvidenceVertexInput = z.infer<typeof AddEvidenceVertexInputSchema>;
export type AddEvidenceVertexOutput = z.infer<typeof AddEvidenceVertexOutputSchema>;
export type GetVertexInput = z.infer<typeof GetVertexInputSchema>;
export type GetVertexOutput = z.infer<typeof GetVertexOutputSchema>;
export type UpdateVertexInput = z.infer<typeof UpdateVertexInputSchema>;
export type UpdateVertexOutput = z.infer<typeof UpdateVertexOutputSchema>;
export type InferenceEdgeQuestionInput = z.infer<typeof InferenceEdgeQuestionInputSchema>;
export type ProposeInferenceEdgeInput = z.infer<typeof ProposeInferenceEdgeInputSchema>;
export type ProposeInferenceEdgeOutput = z.infer<typeof ProposeInferenceEdgeOutputSchema>;
export type GetInferenceEdgeInput = z.infer<typeof GetInferenceEdgeInputSchema>;
export type GetInferenceEdgeOutput = z.infer<typeof GetInferenceEdgeOutputSchema>;
export type UpdateInferenceEdgeInput = z.infer<typeof UpdateInferenceEdgeInputSchema>;
export type UpdateInferenceEdgeOutput = z.infer<typeof UpdateInferenceEdgeOutputSchema>;
export type ListCandidateEdgesInput = z.infer<typeof ListCandidateEdgesInputSchema>;
export type ListCandidateEdgesOutput = z.infer<typeof ListCandidateEdgesOutputSchema>;
export type ClaimVertexExpansionsInput = z.infer<typeof ClaimVertexExpansionsInputSchema>;
export type VertexExpansionClaim = z.infer<typeof VertexExpansionClaimSchema>;
export type ClaimVertexExpansionsOutput = z.infer<typeof ClaimVertexExpansionsOutputSchema>;
export type SetVertexExpansionStateInput = z.infer<typeof SetVertexExpansionStateInputSchema>;
export type SetVertexExpansionStateOutput = z.infer<typeof SetVertexExpansionStateOutputSchema>;
export type ClaimInferenceEdgeInput = z.infer<typeof ClaimInferenceEdgeInputSchema>;
export type ClaimInferenceEdgeOutput = z.infer<typeof ClaimInferenceEdgeOutputSchema>;
export type ClaimInferenceEdgesInput = z.infer<typeof ClaimInferenceEdgesInputSchema>;
export type ClaimInferenceEdgesOutput = z.infer<typeof ClaimInferenceEdgesOutputSchema>;
export type ReleaseInferenceEdgeInput = z.infer<typeof ReleaseInferenceEdgeInputSchema>;
export type ReleaseInferenceEdgeOutput = z.infer<typeof ReleaseInferenceEdgeOutputSchema>;
export type AnswerEvidenceQuestionInput = z.infer<typeof AnswerEvidenceQuestionInputSchema>;
export type AnswerEvidenceQuestionOutput = z.infer<typeof AnswerEvidenceQuestionOutputSchema>;
export type CompleteInferenceEdgeInput = z.infer<typeof CompleteInferenceEdgeInputSchema>;
export type CompleteInferenceEdgeOutput = z.infer<typeof CompleteInferenceEdgeOutputSchema>;
export type BlockInferenceEdgeInput = z.infer<typeof BlockInferenceEdgeInputSchema>;
export type BlockInferenceEdgeOutput = z.infer<typeof BlockInferenceEdgeOutputSchema>;
export type GetContextForVertexInput = z.infer<typeof GetContextForVertexInputSchema>;
export type GetContextForVertexOutput = z.infer<typeof GetContextForVertexOutputSchema>;
export type GetDownstreamContextForVertexInput = z.infer<
  typeof GetDownstreamContextForVertexInputSchema
>;
export type GetDownstreamContextForVertexOutput = z.infer<
  typeof GetDownstreamContextForVertexOutputSchema
>;
export type GetReasoningTextForVertexInput = z.infer<typeof GetReasoningTextForVertexInputSchema>;
export type GetReasoningTextForVertexOutput = z.infer<typeof GetReasoningTextForVertexOutputSchema>;
export type GetContextForEdgeInput = z.infer<typeof GetContextForEdgeInputSchema>;
export type GetContextForEdgeOutput = z.infer<typeof GetContextForEdgeOutputSchema>;
export type GetReasoningContextInput = z.infer<typeof GetReasoningContextInputSchema>;
export type GetReasoningContextOutput = z.infer<typeof GetReasoningContextOutputSchema>;
export type ReasoningFormulaGroupState = z.infer<typeof ReasoningFormulaGroupStateSchema>;
export type ReasoningFormulaGroup = z.infer<typeof ReasoningFormulaGroupSchema>;
export type ReasoningGoalAssessment = z.infer<typeof ReasoningGoalAssessmentSchema>;
export type ReasoningStructure = z.infer<typeof ReasoningStructureSchema>;

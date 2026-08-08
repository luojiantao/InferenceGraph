import { z } from 'zod';
import {
  AgentIdSchema,
  EdgeIdSchema,
  EventSeqSchema,
  GraphRevisionSchema,
  LeaseIdSchema,
  QuestionIdSchema,
  SessionIdSchema,
  VertexIdSchema,
} from './ids.js';
import {
  EdgeStateSchema,
  InferenceEdgeSchema,
  VertexKindSchema,
  VertexSchema,
} from './graph.js';
import {
  GoalStateSchema,
  GraphEventSchema,
  GraphSnapshotSchema,
  ProjectionPolicySchema,
  ReasoningSessionSchema,
  SearchStrategySchema,
  SessionBudgetSchema,
} from './session.js';
import { EdgeExecutionContextSchema, VertexExpansionContextSchema } from './context.js';

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

// --- 3. list_reasoning_sessions ---
export const ListReasoningSessionsInputSchema = z.object({
  includeFinished: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(100),
});
export const ListReasoningSessionsOutputSchema = z.object({
  sessions: z.array(ReasoningSessionSchema),
});

// --- 4. finish_reasoning_session ---
export const FinishReasoningSessionInputSchema = WriteCommandBase.extend({
  goalState: GoalStateSchema,
  reason: z.string().min(1).max(2000),
});
export const FinishReasoningSessionOutputSchema = RevisionAck.extend({
  session: ReasoningSessionSchema,
  /** Candidate/Leased edges transitioned to Abandoned by this call. */
  abandonedEdgeIds: z.array(EdgeIdSchema),
});

// --- 5. add_state_vertex ---
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

// --- 6. add_evidence_vertex ---
export const AddEvidenceVertexInputSchema = AddStateVertexInputSchema;
export const AddEvidenceVertexOutputSchema = AddStateVertexOutputSchema;

// --- 7. get_vertex ---
export const GetVertexInputSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
});
export const GetVertexOutputSchema = z.object({
  vertex: VertexSchema,
  incomingEdgeIds: z.array(EdgeIdSchema),
  outgoingEdgeIds: z.array(EdgeIdSchema),
});

// --- 8. propose_inference_edge ---
export const ProposeInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema.optional(),
  sourceVertexIds: z.array(VertexIdSchema).min(1),
  targetVertexIds: z.array(VertexIdSchema).min(1),
  label: z.string().min(1).max(400),
  cost: z.number().finite().nonnegative().default(1),
  priority: z.number().finite().default(0),
  evidenceQuestions: z
    .array(
      z.object({
        questionId: QuestionIdSchema.optional(),
        prompt: z.string().min(1).max(2000),
      }),
    )
    .default([]),
  dedupeKey: z.string().min(1).max(400).optional(),
});
export const ProposeInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
  deduplicated: z.boolean(),
});

// --- 9. get_inference_edge ---
export const GetInferenceEdgeInputSchema = z.object({
  sessionId: SessionIdSchema,
  edgeId: EdgeIdSchema,
});
export const GetInferenceEdgeOutputSchema = z.object({ edge: InferenceEdgeSchema });

// --- 10. list_candidate_edges ---
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

// --- 11. claim_inference_edge ---
export const ClaimInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseSeconds: z.number().int().positive().max(86_400).optional(),
});
export const ClaimInferenceEdgeOutputSchema = RevisionAck.extend({
  leaseId: LeaseIdSchema,
  edge: InferenceEdgeSchema,
  context: EdgeExecutionContextSchema,
});

// --- 12. claim_inference_edges ---
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

// --- 13. release_inference_edge ---
export const ReleaseInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseId: LeaseIdSchema,
  reason: z.string().max(2000).optional(),
});
export const ReleaseInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 14. answer_evidence_question ---
export const AnswerEvidenceQuestionInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  questionId: QuestionIdSchema,
  leaseId: LeaseIdSchema,
  answer: z.string().min(1).max(4000),
});
export const AnswerEvidenceQuestionOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 15. complete_inference_edge ---
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

// --- 16. block_inference_edge ---
export const BlockInferenceEdgeInputSchema = WriteCommandBase.extend({
  edgeId: EdgeIdSchema,
  leaseId: LeaseIdSchema.optional(),
  reason: z.string().min(1).max(2000),
});
export const BlockInferenceEdgeOutputSchema = RevisionAck.extend({
  edge: InferenceEdgeSchema,
});

// --- 17. get_context_for_vertex ---
export const GetContextForVertexInputSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
  policy: ProjectionPolicySchema.optional(),
  expansionHandleId: z.string().min(1).max(200).optional(),
});
export const GetContextForVertexOutputSchema = z.object({
  context: VertexExpansionContextSchema,
});

// --- 18. get_context_for_edge ---
export const GetContextForEdgeInputSchema = z.object({
  sessionId: SessionIdSchema,
  edgeId: EdgeIdSchema,
  policy: ProjectionPolicySchema.optional(),
  expansionHandleId: z.string().min(1).max(200).optional(),
});
export const GetContextForEdgeOutputSchema = z.object({
  context: EdgeExecutionContextSchema,
});

// --- 19. get_reasoning_context ---
/**
 * Session-level read-only overview. It deliberately returns neither a single
 * vertex payload nor a single edge payload; use tools 17/18 for those.
 */
export const GetReasoningContextInputSchema = z.object({
  sessionId: SessionIdSchema,
  afterEventSeq: z.number().int().nonnegative().default(0),
  eventLimit: z.number().int().positive().max(1000).default(200),
});
export const GetReasoningContextOutputSchema = z.object({
  snapshot: GraphSnapshotSchema,
  frontierEdgeIds: z.array(EdgeIdSchema),
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
export type ListReasoningSessionsInput = z.infer<typeof ListReasoningSessionsInputSchema>;
export type ListReasoningSessionsOutput = z.infer<typeof ListReasoningSessionsOutputSchema>;
export type FinishReasoningSessionInput = z.infer<typeof FinishReasoningSessionInputSchema>;
export type FinishReasoningSessionOutput = z.infer<typeof FinishReasoningSessionOutputSchema>;
export type AddStateVertexInput = z.infer<typeof AddStateVertexInputSchema>;
export type AddStateVertexOutput = z.infer<typeof AddStateVertexOutputSchema>;
export type AddEvidenceVertexInput = z.infer<typeof AddEvidenceVertexInputSchema>;
export type AddEvidenceVertexOutput = z.infer<typeof AddEvidenceVertexOutputSchema>;
export type GetVertexInput = z.infer<typeof GetVertexInputSchema>;
export type GetVertexOutput = z.infer<typeof GetVertexOutputSchema>;
export type ProposeInferenceEdgeInput = z.infer<typeof ProposeInferenceEdgeInputSchema>;
export type ProposeInferenceEdgeOutput = z.infer<typeof ProposeInferenceEdgeOutputSchema>;
export type GetInferenceEdgeInput = z.infer<typeof GetInferenceEdgeInputSchema>;
export type GetInferenceEdgeOutput = z.infer<typeof GetInferenceEdgeOutputSchema>;
export type ListCandidateEdgesInput = z.infer<typeof ListCandidateEdgesInputSchema>;
export type ListCandidateEdgesOutput = z.infer<typeof ListCandidateEdgesOutputSchema>;
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
export type GetContextForEdgeInput = z.infer<typeof GetContextForEdgeInputSchema>;
export type GetContextForEdgeOutput = z.infer<typeof GetContextForEdgeOutputSchema>;
export type GetReasoningContextInput = z.infer<typeof GetReasoningContextInputSchema>;
export type GetReasoningContextOutput = z.infer<typeof GetReasoningContextOutputSchema>;

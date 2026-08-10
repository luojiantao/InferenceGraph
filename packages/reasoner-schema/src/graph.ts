import { z } from 'zod';
import {
  AgentIdSchema,
  EdgeIdSchema,
  EdgeReferenceIdSchema,
  FormulaIdSchema,
  GraphRevisionSchema,
  IsoTimestampSchema,
  LeaseIdSchema,
  QuestionIdSchema,
  Sha256Schema,
  VertexIdSchema,
  VertexReferenceIdSchema,
} from './ids.js';

/**
 * Vertex kinds are structural roles inside the reasoning workspace, not domain
 * concepts. `Goal` anchors a session, `State` records an asserted situation and
 * `Evidence` records supporting material submitted by an external agent.
 */
export const VertexKindSchema = z.enum(['Goal', 'State', 'Evidence']);
export type VertexKind = z.infer<typeof VertexKindSchema>;

export const VertexSchema = z.object({
  vertexId: VertexIdSchema,
  /** Session-local, immutable Vn reference allocated at creation time. */
  referenceId: VertexReferenceIdSchema,
  kind: VertexKindSchema,
  label: z.string().min(1).max(400),
  /** Opaque agent-supplied payload. The Core stores and returns it verbatim. */
  payload: z.record(z.unknown()).default({}),
  dedupeKey: z.string().min(1).max(400).optional(),
  createdByAgentId: AgentIdSchema,
  createdAt: IsoTimestampSchema,
  createdAtRevision: GraphRevisionSchema,
});
export type Vertex = z.infer<typeof VertexSchema>;

/**
 * Edge lifecycle. Every state has exactly one documented entry path:
 * - Candidate  <- propose_inference_edge
 * - Leased     <- claim_inference_edge / claim_inference_edges
 * - Completed  <- complete_inference_edge
 * - Blocked    <- block_inference_edge
 * - Abandoned  <- derived by finish_reasoning_session (no direct MCP entry)
 * - Invalid    <- derived by recovery-time invariant validation (no direct MCP entry)
 */
export const EdgeStateSchema = z.enum([
  'Candidate',
  'Leased',
  'Completed',
  'Blocked',
  'Abandoned',
  'Invalid',
]);
export type EdgeState = z.infer<typeof EdgeStateSchema>;

export const EvidenceQuestionSchema = z.object({
  questionId: QuestionIdSchema,
  /** Question text is authored by the external agent; the Core never generates it. */
  prompt: z.string().min(1).max(2000),
  answer: z.string().max(4000).optional(),
  answeredByAgentId: AgentIdSchema.optional(),
  answeredAt: IsoTimestampSchema.optional(),
  answeredAtRevision: GraphRevisionSchema.optional(),
});
export type EvidenceQuestion = z.infer<typeof EvidenceQuestionSchema>;

export const EdgeLeaseSchema = z.object({
  leaseId: LeaseIdSchema,
  edgeId: EdgeIdSchema,
  agentId: AgentIdSchema,
  acquiredAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  /**
   * Hash of the EdgeExecutionContext archived in context_projections at claim
   * time. complete_inference_edge compares against this stored value, never
   * against a freshly recomputed projection.
   */
  inputContextHash: Sha256Schema,
});
export type EdgeLease = z.infer<typeof EdgeLeaseSchema>;

/**
 * A directed labelled inference edge. Every persisted edge connects exactly
 * one source vertex to exactly one target vertex, so its state, evidence,
 * lease and completion record are never shared with another relation.
 *
 * The array field names are retained for wire compatibility. Batch proposal
 * input is expanded into independent binary edges before persistence.
 */
export const InferenceEdgeSchema = z.object({
  edgeId: EdgeIdSchema,
  /** Session-local, immutable En reference allocated at creation time. */
  referenceId: EdgeReferenceIdSchema,
  /**
   * Physical edges in the same formula are conjunction operands. Formula
   * groups targeting the same vertex are alternatives (disjunction).
   */
  formulaId: FormulaIdSchema,
  sourceVertexIds: z.array(VertexIdSchema).length(1),
  targetVertexIds: z.array(VertexIdSchema).length(1),
  label: z.string().min(1).max(400),
  state: EdgeStateSchema,
  /** Lower cost is preferred by Priority search and minimal hyperpath. */
  cost: z.number().finite().nonnegative().default(1),
  /** Higher priority is selected first; independent of cost. */
  priority: z.number().finite().default(0),
  /** Evidence questions are edge attributes, never separate vertices or edges. */
  evidenceQuestions: z.array(EvidenceQuestionSchema).default([]),
  conclusion: z.string().max(4000).optional(),
  blockedReason: z.string().max(2000).optional(),
  lease: EdgeLeaseSchema.optional(),
  dedupeKey: z.string().min(1).max(400).optional(),
  proposedByAgentId: AgentIdSchema,
  createdAt: IsoTimestampSchema,
  createdAtRevision: GraphRevisionSchema,
  updatedAtRevision: GraphRevisionSchema,
});
export type InferenceEdge = z.infer<typeof InferenceEdgeSchema>;

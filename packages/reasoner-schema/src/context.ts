import { z } from 'zod';
import {
  EdgeIdSchema,
  GraphRevisionSchema,
  IsoTimestampSchema,
  SessionIdSchema,
  Sha256Schema,
  VertexIdSchema,
} from './ids.js';
import { EvidenceQuestionSchema, InferenceEdgeSchema, VertexSchema } from './graph.js';
import { GoalStateSchema, ProjectionPolicySchema } from './session.js';

/** Handle allowing an agent to request a wider projection without guessing IDs. */
export const ExpansionHandleSchema = z.object({
  handleId: z.string().min(1).max(200),
  policy: ProjectionPolicySchema,
  description: z.string().min(1).max(400),
});
export type ExpansionHandle = z.infer<typeof ExpansionHandleSchema>;

export const GlobalNavigationSummarySchema = z.object({
  vertexCount: z.number().int().nonnegative(),
  edgeCountByState: z.record(z.number().int().nonnegative()),
  frontierEdgeIds: z.array(EdgeIdSchema),
  goalState: GoalStateSchema,
  maxCompletedDepth: z.number().int().nonnegative(),
});
export type GlobalNavigationSummary = z.infer<typeof GlobalNavigationSummarySchema>;

export const EvidenceDigestSchema = z.object({
  vertexId: VertexIdSchema,
  label: z.string(),
  supportedEdgeIds: z.array(EdgeIdSchema),
});
export type EvidenceDigest = z.infer<typeof EvidenceDigestSchema>;

/** Payload returned by get_context_for_vertex. */
export const VertexExpansionContextSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
  policy: ProjectionPolicySchema,
  graphRevision: GraphRevisionSchema,
  goalVertex: VertexSchema,
  currentVertex: VertexSchema,
  /** Necessary ancestor dependency subgraph of the current vertex. */
  ancestorVertices: z.array(VertexSchema),
  ancestorEdges: z.array(InferenceEdgeSchema),
  evidenceDigests: z.array(EvidenceDigestSchema),
  globalSummary: GlobalNavigationSummarySchema.optional(),
  expansionHandles: z.array(ExpansionHandleSchema),
  omittedVertexIds: z.array(VertexIdSchema),
  omittedEdgeIds: z.array(EdgeIdSchema),
  contextHash: Sha256Schema,
});
export type VertexExpansionContext = z.infer<typeof VertexExpansionContextSchema>;

/** Payload returned by get_context_for_edge and archived at claim time. */
export const EdgeExecutionContextSchema = z.object({
  sessionId: SessionIdSchema,
  edgeId: EdgeIdSchema,
  policy: ProjectionPolicySchema,
  graphRevision: GraphRevisionSchema,
  goalVertex: VertexSchema,
  edge: InferenceEdgeSchema,
  sourceVertices: z.array(VertexSchema),
  targetVertices: z.array(VertexSchema),
  evidenceQuestions: z.array(EvidenceQuestionSchema),
  ancestorVertices: z.array(VertexSchema),
  ancestorEdges: z.array(InferenceEdgeSchema),
  globalSummary: GlobalNavigationSummarySchema.optional(),
  expansionHandles: z.array(ExpansionHandleSchema),
  omittedVertexIds: z.array(VertexIdSchema),
  omittedEdgeIds: z.array(EdgeIdSchema),
  /**
   * Hash over the edge-local material only (sources, target, label, cost and
   * evidence questions). It deliberately excludes unrelated graph growth so
   * that concurrent progress elsewhere never invalidates this claim.
   */
  contextHash: Sha256Schema,
});
export type EdgeExecutionContext = z.infer<typeof EdgeExecutionContextSchema>;

/**
 * Audit-only record of a served projection. Writing it never increments
 * GraphRevision and never emits a GraphEvent.
 */
export const ContextProjectionRecordSchema = z.object({
  projectionId: z.string().min(1).max(200),
  sessionId: SessionIdSchema,
  subjectKind: z.enum(['Vertex', 'Edge']),
  subjectId: z.string().min(1).max(200),
  policy: ProjectionPolicySchema,
  graphRevision: GraphRevisionSchema,
  snapshotHash: Sha256Schema,
  contextHash: Sha256Schema,
  includedVertexIds: z.array(VertexIdSchema),
  includedEdgeIds: z.array(EdgeIdSchema),
  omittedVertexIds: z.array(VertexIdSchema),
  omittedEdgeIds: z.array(EdgeIdSchema),
  expansionHandles: z.array(ExpansionHandleSchema),
  createdAt: IsoTimestampSchema,
});
export type ContextProjectionRecord = z.infer<typeof ContextProjectionRecordSchema>;

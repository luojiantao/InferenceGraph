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

/**
 * One deterministic downstream route from the current vertex to the session
 * Goal. This is navigation context, not proof: a physical edge can belong to
 * an AND formula whose other premises are not part of this linear path.
 */
export const GoalPathSummarySchema = z.object({
  reachable: z.boolean(),
  hopCount: z.number().int().nonnegative().nullable(),
  /** Ordered from the current vertex to the Goal; empty when unreachable. */
  vertices: z.array(VertexSchema),
  /** Ordered to connect adjacent vertices; empty when unreachable or already at Goal. */
  edges: z.array(InferenceEdgeSchema),
});
export type GoalPathSummary = z.infer<typeof GoalPathSummarySchema>;

/** Payload returned by get_downstream_context_for_vertex. */
export const VertexDownstreamContextSchema = z.object({
  sessionId: SessionIdSchema,
  vertexId: VertexIdSchema,
  graphRevision: GraphRevisionSchema,
  currentVertex: VertexSchema,
  goalVertex: VertexSchema,
  /** Every persisted physical edge that directly consumes the current vertex. */
  directDownstreamEdges: z.array(InferenceEdgeSchema),
  /** Deduplicated targets of directDownstreamEdges. */
  directDownstreamVertices: z.array(VertexSchema),
  /** Shortest retained recorded route to Goal; it does not imply completed support. */
  goalPathSummary: GoalPathSummarySchema,
});
export type VertexDownstreamContext = z.infer<typeof VertexDownstreamContextSchema>;

/** Human-readable rendering of a vertex dependency projection. */
export const VertexReasoningTextSchema = z.object({
  context: VertexExpansionContextSchema,
  /** Markdown narrative. It includes the Mermaid source in a fenced code block. */
  reasoningText: z.string().min(1),
  /** Raw Mermaid flowchart source for callers that render it separately. */
  mermaid: z.string().min(1),
});
export type VertexReasoningText = z.infer<typeof VertexReasoningTextSchema>;

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

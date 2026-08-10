import { z } from 'zod';
import {
  AgentIdSchema,
  EdgeIdSchema,
  EventSeqSchema,
  GraphRevisionSchema,
  IsoTimestampSchema,
  SessionIdSchema,
  Sha256Schema,
  VertexIdSchema,
} from './ids.js';
import { InferenceEdgeSchema, VertexSchema } from './graph.js';

/** Terminal and non-terminal goal states of a reasoning session. */
export const GoalStateSchema = z.enum([
  'Exploring',
  'CandidateFound',
  'Verifying',
  'GoalSatisfied',
  'GoalConflicted',
  'Exhausted',
  'BudgetExceeded',
  'StructurallyInvalid',
]);
export type GoalState = z.infer<typeof GoalStateSchema>;

export const TERMINAL_GOAL_STATES: readonly GoalState[] = [
  'GoalSatisfied',
  'GoalConflicted',
  'Exhausted',
  'BudgetExceeded',
  'StructurallyInvalid',
];

export const SearchStrategySchema = z.enum(['DFS', 'BFS', 'Priority']);
export type SearchStrategy = z.infer<typeof SearchStrategySchema>;

export const ProjectionPolicySchema = z.enum([
  'CurrentOnly',
  'DependencySubgraph',
  'DependencySubgraphWithGlobalSummary',
  'FullGraph',
]);
export type ProjectionPolicy = z.infer<typeof ProjectionPolicySchema>;

export const SessionBudgetSchema = z.object({
  maxEdges: z.number().int().positive().max(100_000).default(2_000),
  maxDepth: z.number().int().positive().max(1_000).default(64),
  maxLeaseSeconds: z.number().int().positive().max(86_400).default(900),
});
export type SessionBudget = z.infer<typeof SessionBudgetSchema>;

/** Human-facing metadata. It never replaces the immutable Vn/En references. */
export const SessionAliasSchema = z.string().trim().min(1).max(120);
export const SessionTagSchema = z.string().trim().min(1).max(40);
export const SessionTagListSchema = z
  .array(SessionTagSchema)
  .max(12)
  .superRefine((tags, context) => {
    const seen = new Set<string>();
    for (const [index, tag] of tags.entries()) {
      if (seen.has(tag)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'session tags must be unique',
          path: [index],
        });
      }
      seen.add(tag);
    }
  });
export const SessionTagsSchema = SessionTagListSchema.default([]);

export const ReasoningSessionSchema = z.object({
  sessionId: SessionIdSchema,
  alias: SessionAliasSchema.optional(),
  tags: SessionTagsSchema,
  goalVertexId: VertexIdSchema,
  goalState: GoalStateSchema,
  strategy: SearchStrategySchema,
  projectionPolicy: ProjectionPolicySchema,
  budget: SessionBudgetSchema,
  graphRevision: GraphRevisionSchema,
  lastEventSeq: EventSeqSchema.or(z.literal(0)),
  structuralError: z.string().max(2000).optional(),
  finishedReason: z.string().max(2000).optional(),
  createdByAgentId: AgentIdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ReasoningSession = z.infer<typeof ReasoningSessionSchema>;

export const GraphEventKindSchema = z.enum([
  'SessionCreated',
  'SessionMetadataUpdated',
  'SessionEdgeBudgetIncreased',
  'VertexAdded',
  'VertexUpdated',
  'EdgeProposed',
  'EdgeUpdated',
  'EdgeClaimed',
  'EdgeLeaseReleased',
  'EdgeLeaseExpired',
  'EdgeCompleted',
  'EdgeBlocked',
  'EdgeAbandoned',
  'EdgeInvalidated',
  'EvidenceQuestionAnswered',
  'GoalStateChanged',
  'SessionFinished',
  'StructuralErrorDetected',
]);
export type GraphEventKind = z.infer<typeof GraphEventKindSchema>;

/**
 * Immutable audit record. `eventSeq` is strictly increasing per session and is
 * the only cursor used for paging, resume and gap detection. `graphRevision` is
 * shared by all events written in the same transaction and must not be used as
 * a cursor.
 */
export const GraphEventSchema = z.object({
  eventSeq: EventSeqSchema,
  sessionId: SessionIdSchema,
  graphRevision: GraphRevisionSchema,
  kind: GraphEventKindSchema,
  vertexId: VertexIdSchema.optional(),
  edgeId: EdgeIdSchema.optional(),
  actorAgentId: AgentIdSchema,
  detail: z.record(z.unknown()).default({}),
  occurredAt: IsoTimestampSchema,
});
export type GraphEvent = z.infer<typeof GraphEventSchema>;

export const GraphSnapshotSchema = z.object({
  session: ReasoningSessionSchema,
  vertices: z.array(VertexSchema),
  edges: z.array(InferenceEdgeSchema),
  graphRevision: GraphRevisionSchema,
  snapshotHash: Sha256Schema,
});
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

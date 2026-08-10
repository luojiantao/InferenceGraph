import { z } from 'zod';

/**
 * Identifiers are caller-supplied opaque strings. The Core never parses them for
 * meaning; it only requires them to be stable, non-empty and comparable so that
 * deterministic ordering (search, topological sort, hashing) is reproducible.
 */
const identifier = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .max(200, `${label} must be at most 200 characters`)
    .regex(/^[A-Za-z0-9._:-]+$/, `${label} may only contain A-Za-z0-9 . _ : -`);

export const SessionIdSchema = identifier('sessionId').brand<'SessionId'>();
export const VertexIdSchema = identifier('vertexId').brand<'VertexId'>();
export const EdgeIdSchema = identifier('edgeId').brand<'EdgeId'>();
/** Opaque grouping id for the independent edges that form one vertex formula. */
export const FormulaIdSchema = identifier('formulaId').brand<'FormulaId'>();
/** Persisted, session-local display/reference id assigned when an entity is created. */
export const VertexReferenceIdSchema = z
  .string()
  .regex(/^V[1-9][0-9]*$/, 'must be V1, V2, ...')
  .brand<'VertexReferenceId'>();
/** Persisted, session-local display/reference id assigned when an entity is created. */
export const EdgeReferenceIdSchema = z
  .string()
  .regex(/^E[1-9][0-9]*$/, 'must be E1, E2, ...')
  .brand<'EdgeReferenceId'>();
export const QuestionIdSchema = identifier('questionId').brand<'QuestionId'>();
export const LeaseIdSchema = identifier('leaseId').brand<'LeaseId'>();
export const AgentIdSchema = identifier('agentId').brand<'AgentId'>();

export type SessionId = z.infer<typeof SessionIdSchema>;
export type VertexId = z.infer<typeof VertexIdSchema>;
export type EdgeId = z.infer<typeof EdgeIdSchema>;
export type FormulaId = z.infer<typeof FormulaIdSchema>;
export type VertexReferenceId = z.infer<typeof VertexReferenceIdSchema>;
export type EdgeReferenceId = z.infer<typeof EdgeReferenceIdSchema>;
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export type LeaseId = z.infer<typeof LeaseIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Monotonic optimistic-concurrency counter for the whole session graph. */
export const GraphRevisionSchema = z.number().int().nonnegative().brand<'GraphRevision'>();
export type GraphRevision = z.infer<typeof GraphRevisionSchema>;

/**
 * Session-wide strictly increasing event cursor. Multiple events written in one
 * transaction share a graphRevision but never share an eventSeq, so paging,
 * resume and gap detection are defined against eventSeq alone.
 */
export const EventSeqSchema = z.number().int().positive().brand<'EventSeq'>();
export type EventSeq = z.infer<typeof EventSeqSchema>;

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Hex sha256 digest used for snapshot and context-projection archives. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex');
export type Sha256 = z.infer<typeof Sha256Schema>;

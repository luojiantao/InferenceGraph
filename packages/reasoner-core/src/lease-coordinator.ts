import type {
  AgentId,
  EdgeId,
  InferenceEdge,
  IsoTimestamp,
  LeaseId,
} from '@reasoner/schema';

export const isLeaseExpired = (edge: InferenceEdge, now: IsoTimestamp): boolean => {
  const lease = edge.lease;
  if (lease === undefined) return false;
  return Date.parse(lease.expiresAt) <= Date.parse(now);
};

/**
 * Edges whose lease has lapsed. These are reclaimed to Candidate *inside the
 * same transaction* as the claim that discovers them, so reclamation and claim
 * share one revision increment. Committing reclamation separately would bump the
 * revision and make the caller's own compare-and-set fail.
 */
export const findExpiredLeases = (
  edges: readonly InferenceEdge[],
  now: IsoTimestamp,
): readonly InferenceEdge[] =>
  edges.filter((edge) => edge.state === 'Leased' && isLeaseExpired(edge, now));

/** Returns the edge with its lease dropped and state reset to Candidate. */
export const reclaimEdge = (edge: InferenceEdge): InferenceEdge => {
  const { lease: _lease, ...rest } = edge;
  return { ...rest, state: 'Candidate' };
};

export interface LeaseGrant {
  readonly leaseId: LeaseId;
  readonly agentId: AgentId;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly inputContextHash: string;
}

export const grantLease = (edge: InferenceEdge, grant: LeaseGrant): InferenceEdge => ({
  ...edge,
  state: 'Leased',
  lease: {
    leaseId: grant.leaseId,
    edgeId: edge.edgeId,
    agentId: grant.agentId,
    acquiredAt: grant.acquiredAt,
    expiresAt: grant.expiresAt,
    inputContextHash: grant.inputContextHash,
  },
});

export const releaseLease = (edge: InferenceEdge): InferenceEdge => {
  const { lease: _lease, ...rest } = edge;
  return { ...rest, state: 'Candidate' };
};

export const computeExpiry = (now: IsoTimestamp, leaseSeconds: number): IsoTimestamp =>
  new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();

export type LeaseCheck =
  | { readonly ok: true; readonly edge: InferenceEdge }
  | { readonly ok: false; readonly reason: 'LeaseNotHeld' | 'LeaseExpired'; readonly message: string };

/**
 * Verifies the caller still owns a live lease on the edge. Callers that lost
 * their lease to expiry must be rejected even if they present the original
 * leaseId, otherwise two agents could complete the same edge.
 */
export const checkLeaseHeld = (
  edge: InferenceEdge,
  leaseId: LeaseId,
  agentId: AgentId,
  now: IsoTimestamp,
): LeaseCheck => {
  const lease = edge.lease;
  if (edge.state !== 'Leased' || lease === undefined) {
    return {
      ok: false,
      reason: 'LeaseNotHeld',
      message: `edge ${edge.edgeId} is ${edge.state}, not Leased`,
    };
  }
  if (lease.leaseId !== leaseId || lease.agentId !== agentId) {
    return {
      ok: false,
      reason: 'LeaseNotHeld',
      message: `edge ${edge.edgeId} is leased by a different agent or lease id`,
    };
  }
  if (isLeaseExpired(edge, now)) {
    return {
      ok: false,
      reason: 'LeaseExpired',
      message: `lease ${leaseId} on edge ${edge.edgeId} expired at ${lease.expiresAt}`,
    };
  }
  return { ok: true, edge };
};

export const isClaimable = (edge: InferenceEdge, now: IsoTimestamp): boolean =>
  edge.state === 'Candidate' || (edge.state === 'Leased' && isLeaseExpired(edge, now));

export type EdgeIdList = readonly EdgeId[];

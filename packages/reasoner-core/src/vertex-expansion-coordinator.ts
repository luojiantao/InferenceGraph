import type {
  AgentId,
  IsoTimestamp,
  LeaseId,
  Vertex,
  VertexExpansion,
  VertexExpansionLease,
} from '@reasoner/schema';

export const isActiveVertexExpansion = (expansion: VertexExpansion): boolean =>
  expansion.state === 'Expanding' || expansion.state === 'AwaitingContext';

/** Builds the durable default for a newly created or legacy vertex. */
export const defaultVertexExpansion = (vertex: Vertex): VertexExpansion => ({
  vertexId: vertex.vertexId,
  state: vertex.kind === 'Evidence' ? 'NotApplicable' : 'Pending',
  updatedAt: vertex.createdAt,
  updatedAtRevision: vertex.createdAtRevision,
});

export const isVertexExpansionLeaseExpired = (
  expansion: VertexExpansion,
  now: IsoTimestamp,
): boolean =>
  expansion.lease !== undefined && Date.parse(expansion.lease.expiresAt) <= Date.parse(now);

export const findExpiredVertexExpansions = (
  expansions: readonly VertexExpansion[],
  now: IsoTimestamp,
): readonly VertexExpansion[] =>
  expansions.filter(
    (expansion) => isActiveVertexExpansion(expansion) && isVertexExpansionLeaseExpired(expansion, now),
  );

const withoutLease = (expansion: VertexExpansion): Omit<VertexExpansion, 'lease' | 'reason'> => {
  const { lease: _lease, reason: _reason, ...rest } = expansion;
  return rest;
};

export const requeueVertexExpansion = (
  expansion: VertexExpansion,
  now: IsoTimestamp,
  revision: number,
  reason?: string,
): VertexExpansion => ({
  ...withoutLease(expansion),
  state: 'Pending',
  ...(reason === undefined ? {} : { reason }),
  updatedAt: now,
  updatedAtRevision: revision as VertexExpansion['updatedAtRevision'],
});

export const grantVertexExpansion = (
  expansion: VertexExpansion,
  lease: VertexExpansionLease,
  now: IsoTimestamp,
  revision: number,
): VertexExpansion => ({
  ...withoutLease(expansion),
  state: 'Expanding',
  lease,
  updatedAt: now,
  updatedAtRevision: revision as VertexExpansion['updatedAtRevision'],
});

export type VertexExpansionSettlementState = 'Pending' | 'AwaitingContext' | 'Expanded' | 'Blocked';

export const settleVertexExpansion = (
  expansion: VertexExpansion,
  state: VertexExpansionSettlementState,
  now: IsoTimestamp,
  revision: number,
  reason?: string,
): VertexExpansion => {
  const base = {
    ...withoutLease(expansion),
    state,
    ...(reason === undefined ? {} : { reason }),
    updatedAt: now,
    updatedAtRevision: revision as VertexExpansion['updatedAtRevision'],
  } as const;

  if (state === 'AwaitingContext') {
    const lease = expansion.lease;
    if (lease === undefined) throw new Error('AwaitingContext requires an existing expansion lease');
    return { ...base, lease };
  }
  return base;
};

export type VertexExpansionLeaseCheck =
  | { readonly ok: true; readonly expansion: VertexExpansion }
  | { readonly ok: false; readonly reason: 'LeaseNotHeld' | 'LeaseExpired'; readonly message: string };

/** Verifies a live lease without conflating expansion leases with edge leases. */
export const checkVertexExpansionLease = (
  expansion: VertexExpansion,
  leaseId: LeaseId,
  agentId: AgentId,
  now: IsoTimestamp,
): VertexExpansionLeaseCheck => {
  const lease = expansion.lease;
  if (!isActiveVertexExpansion(expansion) || lease === undefined) {
    return {
      ok: false,
      reason: 'LeaseNotHeld',
      message: `vertex ${expansion.vertexId} is ${expansion.state}, not actively expanding`,
    };
  }
  if (lease.leaseId !== leaseId || lease.agentId !== agentId) {
    return {
      ok: false,
      reason: 'LeaseNotHeld',
      message: `vertex ${expansion.vertexId} is reserved by a different agent or lease id`,
    };
  }
  if (isVertexExpansionLeaseExpired(expansion, now)) {
    return {
      ok: false,
      reason: 'LeaseExpired',
      message: `expansion lease ${leaseId} on vertex ${expansion.vertexId} expired at ${lease.expiresAt}`,
    };
  }
  return { ok: true, expansion };
};

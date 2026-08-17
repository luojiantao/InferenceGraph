"""Reconcile Worker outcomes with graph-verified expansion leases."""

from __future__ import annotations

from typing import Any

from .context_pack import advance_context_pack
from .models import (
    ExpansionSettlementAck,
    GraphSnapshot,
    PendingRetrieval,
    PendingSettlement,
    ResearchResult,
    RunState,
    StepRecord,
    UnresolvedFrontier,
    WorkerResult,
)


def validate_worker_result(payload: dict[str, Any]) -> WorkerResult:
    result = WorkerResult.model_validate(payload)
    if result.final_graph_revision < result.initial_graph_revision:
        raise ValueError("WorkerResult finalGraphRevision cannot be older than initialGraphRevision")
    if result.status == "needs-retrieval" and not result.retrieval_requests:
        raise ValueError("needs-retrieval requires at least one retrievalRequest")
    return result


def _append_unresolved(state: RunState, vertex_id: str, status: str, reason: str) -> None:
    if not any(item.vertex_id == vertex_id and item.status == status for item in state.unresolved_frontier):
        state.unresolved_frontier.append(
            UnresolvedFrontier(vertexId=vertex_id, status=status, reason=reason)
        )


def _step(
    state: RunState,
    pending: PendingSettlement,
    final_graph_revision: int,
    note: str | None = None,
) -> None:
    state.steps.append(
        StepRecord(
            sequence=len(state.steps) + 1,
            targetVertexId=pending.claim.vertex_id,
            workerAgentId=pending.worker_agent_id,
            status=pending.outcome,
            initialGraphRevision=pending.initial_graph_revision,
            finalGraphRevision=final_graph_revision,
            createdEdgeDelta=pending.created_edge_delta,
            note=note,
        )
    )


def reconcile_worker_result(
    state: RunState, snapshot: GraphSnapshot, result: WorkerResult
) -> RunState:
    """Prepare the deterministic MCP settlement required after one Worker returns."""

    next_state = state.model_copy(deep=True)
    claim = next_state.in_flight
    if claim is None:
        raise ValueError("no in-flight expansion claim exists")
    if next_state.pending_settlement is not None:
        raise ValueError("previous expansion settlement has not been acknowledged")
    if snapshot.session_id != next_state.session_id:
        raise ValueError("snapshot sessionId does not match RunState")
    if snapshot.target_vertex_id != claim.vertex_id or result.target_vertex_id != claim.vertex_id:
        raise ValueError("Worker result and graph snapshot must target the claimed vertex")
    if snapshot.target_expansion_state != "Expanding":
        raise ValueError("Worker may not settle its own expansion lease")
    if snapshot.target_expansion_lease_id != claim.lease_id:
        raise ValueError("target expansion lease changed before reconciliation")
    if snapshot.graph_revision < next_state.latest_graph_revision:
        raise ValueError("snapshot graphRevision is older than RunState")
    if result.initial_graph_revision < claim.claimed_graph_revision:
        raise ValueError("WorkerResult initialGraphRevision is older than the MCP claim")
    if result.final_graph_revision > snapshot.graph_revision:
        raise ValueError("WorkerResult finalGraphRevision is newer than the verified snapshot")

    edge_baseline = claim.initial_target_candidate_edge_count or 0
    edge_delta = max(0, snapshot.target_candidate_edge_count - edge_baseline)
    next_state.latest_graph_revision = snapshot.graph_revision

    desired_state = "Blocked"
    reason: str | None = result.stop_reason
    unresolved_reason: str | None = None
    if result.status in {"committed", "no-op", "already-supported", "terminal"}:
        desired_state = "Expanded"
        reason = result.stop_reason or f"Worker reported {result.status}"
    elif result.status == "revision-conflict":
        next_attempt = claim.attempts + 1
        if next_attempt <= next_state.budget.max_retries_per_node:
            desired_state = "Pending"
            reason = f"revision retry {next_attempt} of {next_state.budget.max_retries_per_node}"
        else:
            desired_state = "Blocked"
            reason = "revision retry limit reached"
            unresolved_reason = reason
    elif result.status == "needs-retrieval":
        if next_state.allow_retrieval:
            desired_state = "AwaitingContext"
            reason = result.stop_reason or "awaiting traceable retrieval material"
        else:
            desired_state = "Blocked"
            reason = "retrieval is disabled; " + (result.stop_reason or "context is insufficient")
            unresolved_reason = reason
    else:
        desired_state = "Blocked"
        reason = result.stop_reason or "Worker did not commit a usable expansion"
        unresolved_reason = reason

    next_state.pending_settlement = PendingSettlement(
        claim=claim,
        state=desired_state,
        outcome=result.status,
        workerAgentId=result.worker_agent_id,
        reason=reason,
        createdEdgeDelta=edge_delta,
        initialGraphRevision=result.initial_graph_revision,
        workerFinalGraphRevision=result.final_graph_revision,
        retrievalRequests=result.retrieval_requests,
        unresolvedReason=unresolved_reason,
    )
    return next_state


def _settlement_ack_from_mcp(payload: dict[str, Any]) -> ExpansionSettlementAck:
    vertex = payload.get("vertex")
    expansion = payload.get("expansion")
    if not isinstance(vertex, dict) or not isinstance(expansion, dict):
        raise ValueError("MCP settlement response must include vertex and expansion objects")
    lease = expansion.get("lease")
    compact = {
        "sessionId": payload.get("sessionId"),
        "graphRevision": payload.get("graphRevision"),
        "vertexId": payload.get("vertexId", vertex.get("vertexId")),
        "state": payload.get("state", expansion.get("state")),
        "leaseId": payload.get("leaseId", lease.get("leaseId") if isinstance(lease, dict) else None),
    }
    return ExpansionSettlementAck.model_validate(compact)


def acknowledge_expansion_settlement(state: RunState, payload: dict[str, Any]) -> RunState:
    """Accept only the state actually persisted by `set_vertex_expansion_state`."""

    next_state = state.model_copy(deep=True)
    pending = next_state.pending_settlement
    if pending is None:
        raise ValueError("no pending expansion settlement exists")
    ack = _settlement_ack_from_mcp(payload)
    if ack.session_id != next_state.session_id or ack.vertex_id != pending.claim.vertex_id:
        raise ValueError("settlement acknowledgment targets a different session or vertex")
    if ack.graph_revision < next_state.latest_graph_revision:
        raise ValueError("settlement acknowledgment graphRevision is older than RunState")
    if ack.state != pending.state:
        raise ValueError("MCP persisted a different expansion state than the controller requested")
    if pending.state == "AwaitingContext":
        if ack.lease_id != pending.claim.lease_id:
            raise ValueError("AwaitingContext must retain the original expansion lease")
    elif ack.lease_id is not None:
        raise ValueError("non-active expansion state must not retain a lease")

    next_state.latest_graph_revision = ack.graph_revision
    next_state.pending_settlement = None

    if pending.outcome == "research-completed":
        retrieval = next_state.pending_retrieval
        if retrieval is None or retrieval.claim.vertex_id != pending.claim.vertex_id:
            raise ValueError("research settlement has no matching pending retrieval")
        claim = next_state.in_flight
        if claim is None or claim.vertex_id != pending.claim.vertex_id:
            raise ValueError("research settlement has no matching in-flight claim")
        next_state.pending_retrieval = None
        next_state.in_flight = None
        _step(next_state, pending, ack.graph_revision, "Context Pack refreshed; vertex returned to MCP frontier")
        return next_state

    claim = next_state.in_flight
    if claim is None or claim.vertex_id != pending.claim.vertex_id:
        raise ValueError("worker settlement has no matching in-flight claim")

    # AwaitingContext is an active service state: retain the same claim locally
    # until the researcher returns and the controller explicitly releases it
    # back to Pending. Clearing it here would lose the lease needed for that
    # later settlement.
    if pending.outcome == "needs-retrieval" and pending.state == "AwaitingContext":
        next_state.pending_retrieval = PendingRetrieval(
            claim=pending.claim,
            requests=pending.retrieval_requests,
        )
        next_state.created_edge_count += pending.created_edge_delta
        _step(next_state, pending, ack.graph_revision)
        return next_state

    next_state.in_flight = None

    if pending.outcome in {"committed", "no-op", "already-supported", "terminal"}:
        next_state.expanded_node_count += 1
    elif pending.outcome == "revision-conflict":
        attempts = pending.claim.attempts + 1
        next_state.attempts_by_vertex[pending.claim.vertex_id] = attempts
        if pending.state == "Blocked":
            _append_unresolved(
                next_state,
                pending.claim.vertex_id,
                pending.outcome,
                pending.unresolved_reason or "revision retry limit reached",
            )
    elif pending.outcome == "needs-retrieval":
        _append_unresolved(
            next_state,
            pending.claim.vertex_id,
            pending.outcome,
            pending.unresolved_reason or pending.reason or "retrieval unavailable",
        )
    elif pending.state == "Blocked":
        _append_unresolved(
            next_state,
            pending.claim.vertex_id,
            pending.outcome,
            pending.unresolved_reason or pending.reason or "expansion blocked",
        )

    next_state.created_edge_count += pending.created_edge_delta
    _step(next_state, pending, ack.graph_revision)
    return next_state


def reconcile_research_result(state: RunState, result: ResearchResult) -> RunState:
    """Advance Context Pack, then request MCP to return the held vertex to Pending."""

    next_state = state.model_copy(deep=True)
    pending = next_state.pending_retrieval
    if pending is None:
        raise ValueError("no pending retrieval exists")
    if next_state.pending_settlement is not None:
        raise ValueError("cannot reconcile research while another settlement is pending")
    if result.target_vertex_id != pending.claim.vertex_id:
        raise ValueError("research result targets a different vertex")

    next_state.context_pack = advance_context_pack(next_state.context_pack, result.materials)
    next_state.pending_settlement = PendingSettlement(
        claim=pending.claim,
        state="Pending",
        outcome="research-completed",
        workerAgentId=result.worker_agent_id,
        reason="retrieval context refreshed",
    )
    return next_state

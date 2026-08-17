"""Single-worker orchestration that delegates target selection to InferenceGraph."""

from __future__ import annotations

from typing import Any

from .models import (
    ClaimedExpansion,
    ExpansionClaimResponse,
    GraphSnapshot,
    NextAction,
    RunState,
)
from .packet import build_research_packet, build_worker_packet


def _stop(state: RunState, reason: str) -> tuple[RunState, NextAction]:
    state.stop_condition = reason
    return state, NextAction(kind="stop", reason=reason)


def _budget_stop_reason(state: RunState, snapshot: GraphSnapshot | None = None) -> str | None:
    budget = state.budget
    if isinstance(budget.max_expanded_nodes, int) and state.expanded_node_count >= budget.max_expanded_nodes:
        return "maxExpandedNodes reached"
    if isinstance(budget.max_edges, int) and state.created_edge_count >= budget.max_edges:
        return "maxEdges reached"
    if snapshot is not None and snapshot.remaining_edge_budget == 0:
        return "InferenceGraph edge budget exhausted"
    return None


def build_claim_payload(state: RunState) -> dict[str, object]:
    """Build the one-at-a-time MCP reservation request; MCP owns DFS/BFS/Priority."""

    return {
        "sessionId": state.session_id,
        "baseGraphRevision": state.latest_graph_revision,
        "agentId": state.agent_id,
        "rootVertexId": state.root_vertex_id,
        "maxVertices": 1,
        "maxDepth": state.budget.max_depth,
    }


def build_settlement_payload(state: RunState) -> dict[str, object]:
    pending = state.pending_settlement
    if pending is None:
        raise ValueError("no pending expansion settlement exists")
    payload: dict[str, object] = {
        "sessionId": state.session_id,
        "baseGraphRevision": state.latest_graph_revision,
        "agentId": state.agent_id,
        "vertexId": pending.claim.vertex_id,
        "leaseId": pending.claim.lease_id,
        "state": pending.state,
    }
    if pending.reason is not None:
        payload["reason"] = pending.reason
    return payload


def select_next_action(
    state: RunState, snapshot: GraphSnapshot | None = None
) -> tuple[RunState, NextAction]:
    """Select a bridge action without reproducing InferenceGraph's traversal order."""

    next_state = state.model_copy(deep=True)
    if next_state.stop_condition is not None:
        return next_state, NextAction(kind="stop", reason=next_state.stop_condition)

    if next_state.pending_settlement is not None:
        return next_state, NextAction(
            kind="set-vertex-expansion-state",
            reason="Worker or research outcome must be persisted before another claim",
            targetVertexId=next_state.pending_settlement.claim.vertex_id,
            payload=build_settlement_payload(next_state),
        )

    if next_state.pending_retrieval is not None:
        if not next_state.allow_retrieval:
            return _stop(next_state, "retrieval requested but allowRetrieval is false")
        pending = next_state.pending_retrieval
        return next_state, NextAction(
            kind="spawn-researcher",
            reason="claimed vertex awaits traceable material",
            targetVertexId=pending.claim.vertex_id,
            payload=build_research_packet(next_state, pending),
        )

    if next_state.in_flight is not None:
        return next_state, NextAction(
            kind="request-graph-snapshot",
            reason="a claimed Worker must return and be reconciled before another dispatch",
            targetVertexId=next_state.in_flight.vertex_id,
        )

    budget_reason = _budget_stop_reason(next_state, snapshot)
    if budget_reason is not None:
        return _stop(next_state, budget_reason)

    return next_state, NextAction(
        kind="claim-vertex-expansions",
        reason="InferenceGraph must select and reserve the next expansion target",
        targetVertexId=next_state.root_vertex_id,
        payload=build_claim_payload(next_state),
    )


def _claim_from_mcp(raw: dict[str, Any], graph_revision: int, attempts: int) -> ClaimedExpansion:
    vertex = raw.get("vertex")
    expansion = raw.get("expansion")
    if not isinstance(vertex, dict) or not isinstance(expansion, dict):
        raise ValueError("MCP claim must include vertex and expansion objects")
    vertex_id = raw.get("vertexId", vertex.get("vertexId"))
    lease_id = raw.get("leaseId")
    if not isinstance(vertex_id, str) or not isinstance(lease_id, str):
        raise ValueError("MCP claim must include vertexId and leaseId")
    if expansion.get("state") != "Expanding":
        raise ValueError("MCP claim expansion state must be Expanding")
    lease = expansion.get("lease")
    if isinstance(lease, dict) and lease.get("leaseId") != lease_id:
        raise ValueError("MCP claim leaseId does not match expansion lease")
    return ClaimedExpansion(
        vertexId=vertex_id,
        leaseId=lease_id,
        depth=raw.get("depth"),
        priority=raw.get("priority", 0),
        rank=raw.get("rank"),
        claimedGraphRevision=graph_revision,
        attempts=attempts,
    )


def accept_expansion_claim(
    state: RunState,
    claim_payload: dict[str, Any],
    snapshot: GraphSnapshot,
) -> tuple[RunState, NextAction]:
    """Accept one MCP claim only after a target snapshot proves the active lease."""

    next_state = state.model_copy(deep=True)
    if next_state.in_flight is not None or next_state.pending_settlement is not None:
        raise ValueError("cannot accept a claim while another expansion is active")
    response = ExpansionClaimResponse.model_validate(claim_payload)
    if response.session_id != next_state.session_id or snapshot.session_id != next_state.session_id:
        raise ValueError("claim response or snapshot sessionId does not match RunState")
    if response.graph_revision < next_state.latest_graph_revision:
        raise ValueError("MCP claim response graphRevision is older than RunState")
    if snapshot.graph_revision < response.graph_revision:
        raise ValueError("target snapshot is older than the MCP claim response")
    if len(response.claims) > 1:
        raise ValueError("serial controller accepts exactly one claimed vertex")
    if not response.claims:
        next_state.latest_graph_revision = max(next_state.latest_graph_revision, response.graph_revision)
        return _stop(next_state, "InferenceGraph expansion frontier is empty")

    raw_claim = response.claims[0]
    if not isinstance(raw_claim, dict):
        raise ValueError("MCP claim entry must be an object")
    raw_vertex = raw_claim.get("vertex")
    vertex_id = raw_claim.get("vertexId")
    if vertex_id is None and isinstance(raw_vertex, dict):
        vertex_id = raw_vertex.get("vertexId")
    if not isinstance(vertex_id, str):
        raise ValueError("MCP claim entry has no vertexId")
    attempts = next_state.attempts_by_vertex.get(vertex_id, 0)
    claim = _claim_from_mcp(raw_claim, response.graph_revision, attempts)
    if claim.depth > next_state.budget.max_depth:
        raise ValueError("MCP claimed a vertex beyond maxDepth")
    if snapshot.target_vertex_id != claim.vertex_id:
        raise ValueError("target snapshot does not match claimed vertex")
    if snapshot.target_kind == "Evidence":
        raise ValueError("MCP must not claim Evidence for reverse expansion")
    if snapshot.target_expansion_state != "Expanding":
        raise ValueError("target snapshot does not mark the vertex as Expanding")
    if snapshot.target_expansion_lease_id != claim.lease_id:
        raise ValueError("target snapshot expansion lease does not match the MCP claim")
    if snapshot.session_status != "active":
        return _stop(next_state, f"session is {snapshot.session_status}")

    budget_reason = _budget_stop_reason(next_state, snapshot)
    if budget_reason is not None:
        raise ValueError(f"MCP claimed a vertex after stop condition: {budget_reason}")

    next_state.latest_graph_revision = snapshot.graph_revision
    next_state.in_flight = claim.model_copy(
        update={"initial_target_candidate_edge_count": snapshot.target_candidate_edge_count}
    )
    dispatched = next_state.in_flight
    return next_state, NextAction(
        kind="spawn-worker",
        reason="MCP selected and reserved one eligible State or Goal",
        targetVertexId=dispatched.vertex_id,
        payload=build_worker_packet(next_state, dispatched, snapshot),
    )

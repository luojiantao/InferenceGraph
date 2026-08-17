from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


SCRIPTS = (
    Path(__file__).resolve().parents[3]
    / "AgentSkills"
    / "ig-pi-controller"
    / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from ig_pi_control.models import GraphSnapshot, ResearchResult, WorkerResult  # noqa: E402
from ig_pi_control.normalize import initialize_run, normalize_request  # noqa: E402
from ig_pi_control.reconcile import (  # noqa: E402
    acknowledge_expansion_settlement,
    reconcile_research_result,
    reconcile_worker_result,
)
from ig_pi_control.scheduler import accept_expansion_claim, select_next_action  # noqa: E402


LEASE_ID = "vertex-expansion-lease-1"


def expansion_snapshot(
    *,
    graph_revision: int,
    candidate_count: int = 0,
    state: str = "Expanding",
    lease_id: str | None = LEASE_ID,
) -> GraphSnapshot:
    return GraphSnapshot(
        sessionId="session-1",
        graphRevision=graph_revision,
        targetVertexId="V1",
        targetKind="Goal",
        targetCandidateEdgeCount=candidate_count,
        targetExpansionState=state,
        targetExpansionLeaseId=lease_id,
    )


def dispatched_state(*, allow_retrieval: bool = False, max_retries: int = 1):
    request = normalize_request(
        {
            "goalLabel": "diagnose root cause",
            "agentId": "test-run",
            "allowRetrieval": allow_retrieval,
            "maxRetriesPerNode": max_retries,
        },
        now=datetime(2026, 8, 17, tzinfo=timezone.utc),
    )
    state = initialize_run(request, session_id="session-1", root_vertex_id="V1", graph_revision=2)
    claim = {
        "sessionId": "session-1",
        "graphRevision": 3,
        "claims": [
            {
                "leaseId": LEASE_ID,
                "vertex": {"vertexId": "V1"},
                "expansion": {
                    "vertexId": "V1",
                    "state": "Expanding",
                    "lease": {"leaseId": LEASE_ID},
                },
                "depth": 0,
                "priority": 0,
                "rank": 0,
            }
        ],
    }
    return accept_expansion_claim(state, claim, expansion_snapshot(graph_revision=3))[0]


def settlement_ack(
    *,
    graph_revision: int,
    state: str,
    lease_id: str | None = None,
) -> dict[str, object]:
    expansion: dict[str, object] = {"vertexId": "V1", "state": state}
    if lease_id is not None:
        expansion["lease"] = {"leaseId": lease_id}
    return {
        "sessionId": "session-1",
        "graphRevision": graph_revision,
        "vertex": {"vertexId": "V1"},
        "expansion": expansion,
    }


class ReconcileTests(unittest.TestCase):
    def test_committed_worker_becomes_expanded_only_after_mcp_acknowledges_it(self) -> None:
        state = dispatched_state()
        result = WorkerResult(
            status="committed",
            targetVertexId="V1",
            workerAgentId="test-run:step:1:attempt:0",
            contextPackVersion="cp-0001",
            initialGraphRevision=3,
            finalGraphRevision=5,
            nextStateVertexIds=["untrusted-worker-value"],
        )

        pending = reconcile_worker_result(
            state,
            expansion_snapshot(graph_revision=5, candidate_count=2),
            result,
        )

        self.assertEqual(pending.pending_settlement.state, "Expanded")
        self.assertEqual(pending.expanded_node_count, 0)
        _, action = select_next_action(pending)
        self.assertEqual(action.kind, "set-vertex-expansion-state")
        self.assertEqual(action.payload["leaseId"], LEASE_ID)
        self.assertEqual(action.payload["state"], "Expanded")

        settled = acknowledge_expansion_settlement(
            pending,
            settlement_ack(graph_revision=6, state="Expanded"),
        )

        self.assertIsNone(settled.in_flight)
        self.assertIsNone(settled.pending_settlement)
        self.assertEqual(settled.expanded_node_count, 1)
        self.assertEqual(settled.created_edge_count, 2)
        self.assertNotIn("untrusted-worker-value", str(settled.model_dump()))
        _, next_action = select_next_action(settled)
        self.assertEqual(next_action.kind, "claim-vertex-expansions")

    def test_revision_conflict_returns_the_vertex_to_mcp_frontier_after_ack(self) -> None:
        state = dispatched_state()
        result = WorkerResult(
            status="revision-conflict",
            targetVertexId="V1",
            workerAgentId="test-run:step:1:attempt:0",
            contextPackVersion="cp-0001",
            initialGraphRevision=3,
            finalGraphRevision=3,
        )

        pending = reconcile_worker_result(state, expansion_snapshot(graph_revision=4), result)
        self.assertEqual(pending.pending_settlement.state, "Pending")

        settled = acknowledge_expansion_settlement(
            pending,
            settlement_ack(graph_revision=5, state="Pending"),
        )

        self.assertIsNone(settled.in_flight)
        self.assertEqual(settled.attempts_by_vertex, {"V1": 1})
        _, action = select_next_action(settled)
        self.assertEqual(action.kind, "claim-vertex-expansions")
        self.assertEqual(action.payload["baseGraphRevision"], 5)

    def test_revision_conflict_blocks_after_the_retry_limit(self) -> None:
        state = dispatched_state(max_retries=1)
        state.in_flight = state.in_flight.model_copy(update={"attempts": 1})
        result = WorkerResult(
            status="revision-conflict",
            targetVertexId="V1",
            workerAgentId="test-run:step:1:attempt:1",
            contextPackVersion="cp-0001",
            initialGraphRevision=3,
            finalGraphRevision=3,
        )

        pending = reconcile_worker_result(state, expansion_snapshot(graph_revision=4), result)
        self.assertEqual(pending.pending_settlement.state, "Blocked")

        settled = acknowledge_expansion_settlement(
            pending,
            settlement_ack(graph_revision=5, state="Blocked"),
        )

        self.assertEqual(settled.unresolved_frontier[0].vertex_id, "V1")
        self.assertEqual(settled.unresolved_frontier[0].status, "revision-conflict")

    def test_retrieval_keeps_lease_while_waiting_then_releases_to_mcp_frontier(self) -> None:
        state = dispatched_state(allow_retrieval=True)
        worker_result = WorkerResult(
            status="needs-retrieval",
            targetVertexId="V1",
            workerAgentId="test-run:step:1:attempt:0",
            contextPackVersion="cp-0001",
            initialGraphRevision=3,
            finalGraphRevision=3,
            retrievalRequests=[
                {
                    "question": "Read PLC log",
                    "why": "Need the event sequence",
                    "sourceKinds": ["log"],
                }
            ],
        )
        pending = reconcile_worker_result(state, expansion_snapshot(graph_revision=3), worker_result)
        self.assertEqual(pending.pending_settlement.state, "AwaitingContext")

        awaiting_research = acknowledge_expansion_settlement(
            pending,
            settlement_ack(graph_revision=4, state="AwaitingContext", lease_id=LEASE_ID),
        )
        self.assertIsNotNone(awaiting_research.in_flight)
        self.assertIsNotNone(awaiting_research.pending_retrieval)
        _, research_action = select_next_action(awaiting_research)
        self.assertEqual(research_action.kind, "spawn-researcher")
        self.assertEqual(research_action.payload["expansionLeaseId"], LEASE_ID)

        research_result = ResearchResult(
            targetVertexId="V1",
            workerAgentId="test-run:step:2:attempt:0",
            materials=[
                {
                    "sourceRef": "log://plc/2026-08-17",
                    "excerpt": "The clamp did not report its in-position signal.",
                    "sourceKind": "log",
                }
            ],
        )
        refreshed = reconcile_research_result(awaiting_research, research_result)
        self.assertEqual(refreshed.context_pack.version, "cp-0002")
        self.assertEqual(refreshed.pending_settlement.state, "Pending")
        _, release_action = select_next_action(refreshed)
        self.assertEqual(release_action.kind, "set-vertex-expansion-state")

        released = acknowledge_expansion_settlement(
            refreshed,
            settlement_ack(graph_revision=5, state="Pending"),
        )
        self.assertIsNone(released.pending_retrieval)
        self.assertIsNone(released.in_flight)
        _, next_action = select_next_action(released)
        self.assertEqual(next_action.kind, "claim-vertex-expansions")

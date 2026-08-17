from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


SCRIPTS = (
    Path(__file__).resolve().parents[3]
    / "AgentSkills"
    / "ig-codex-controller"
    / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from ig_control.models import GraphSnapshot  # noqa: E402
from ig_control.normalize import initialize_run, normalize_request  # noqa: E402
from ig_control.scheduler import accept_expansion_claim, select_next_action  # noqa: E402


def make_state():
    request = normalize_request(
        {"goalLabel": "diagnose root cause", "agentId": "test-run"},
        now=datetime(2026, 8, 17, tzinfo=timezone.utc),
    )
    return initialize_run(request, session_id="session-1", root_vertex_id="V1", graph_revision=2)


def claimed_snapshot(
    *,
    vertex_id: str = "V1",
    lease_id: str = "vertex-expansion-lease-1",
    graph_revision: int = 3,
    kind: str = "Goal",
) -> GraphSnapshot:
    return GraphSnapshot(
        sessionId="session-1",
        graphRevision=graph_revision,
        targetVertexId=vertex_id,
        targetKind=kind,
        targetCandidateEdgeCount=0,
        targetExpansionState="Expanding",
        targetExpansionLeaseId=lease_id,
    )


def claim_response(
    *,
    vertex_id: str = "V1",
    lease_id: str = "vertex-expansion-lease-1",
    graph_revision: int = 3,
    depth: int = 0,
) -> dict[str, object]:
    return {
        "sessionId": "session-1",
        "graphRevision": graph_revision,
        "claims": [
            {
                "leaseId": lease_id,
                "vertex": {"vertexId": vertex_id},
                "expansion": {
                    "vertexId": vertex_id,
                    "state": "Expanding",
                    "lease": {"leaseId": lease_id},
                },
                "depth": depth,
                "priority": 0,
                "rank": 0,
            }
        ],
    }


class SchedulerTests(unittest.TestCase):
    def test_next_requests_one_mcp_claim_without_locally_selecting_a_vertex(self) -> None:
        state = make_state()

        next_state, action = select_next_action(state)

        self.assertEqual(action.kind, "claim-vertex-expansions")
        self.assertEqual(action.target_vertex_id, "V1")
        self.assertEqual(
            action.payload,
            {
                "sessionId": "session-1",
                "baseGraphRevision": 2,
                "agentId": "test-run",
                "rootVertexId": "V1",
                "maxVertices": 1,
                "maxDepth": 4,
            },
        )
        self.assertIsNone(next_state.in_flight)
        self.assertNotIn("queue", next_state.model_dump())

    def test_accepts_one_matching_expanding_claim_then_dispatches_worker(self) -> None:
        state = make_state()

        next_state, action = accept_expansion_claim(
            state,
            claim_response(),
            claimed_snapshot(),
        )

        self.assertEqual(action.kind, "spawn-worker")
        self.assertEqual(action.target_vertex_id, "V1")
        self.assertEqual(next_state.latest_graph_revision, 3)
        self.assertIsNotNone(next_state.in_flight)
        self.assertEqual(next_state.in_flight.lease_id, "vertex-expansion-lease-1")
        self.assertEqual(action.payload["expansionLeaseId"], "vertex-expansion-lease-1")
        self.assertIn(
            "claim_vertex_expansions/set_vertex_expansion_state/claim/release/complete/block/finish/delete",
            action.payload["forbidden"],
        )

    def test_rejects_claim_that_does_not_match_the_persisted_lease(self) -> None:
        state = make_state()
        snapshot = claimed_snapshot(lease_id="vertex-expansion-lease-2")

        with self.assertRaisesRegex(ValueError, "lease does not match"):
            accept_expansion_claim(state, claim_response(), snapshot)

    def test_empty_mcp_claim_stops_without_interpreting_it_as_proof(self) -> None:
        state = make_state()
        payload = {"sessionId": "session-1", "graphRevision": 3, "claims": []}

        next_state, action = accept_expansion_claim(state, payload, claimed_snapshot())

        self.assertEqual(action.kind, "stop")
        self.assertEqual(action.reason, "InferenceGraph expansion frontier is empty")
        self.assertEqual(next_state.stop_condition, action.reason)

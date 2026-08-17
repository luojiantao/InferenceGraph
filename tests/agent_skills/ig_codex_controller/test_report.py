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

from ig_control.models import ClaimedExpansion  # noqa: E402
from ig_control.normalize import initialize_run, normalize_request  # noqa: E402
from ig_control.report import render_report  # noqa: E402


class ReportTests(unittest.TestCase):
    def test_reports_the_mcp_held_expansion_lease_and_candidate_is_not_proof(self) -> None:
        request = normalize_request(
            {"goalLabel": "diagnose root cause", "agentId": "test-run"},
            now=datetime(2026, 8, 17, tzinfo=timezone.utc),
        )
        state = initialize_run(request, session_id="session-1", root_vertex_id="V1", graph_revision=0)
        state.in_flight = ClaimedExpansion(
            vertexId="V1",
            leaseId="vertex-expansion-lease-1",
            depth=0,
            priority=0,
            rank=0,
            claimedGraphRevision=1,
        )

        report = render_report(state)

        self.assertIn("session-1", report)
        self.assertIn("lease=`vertex-expansion-lease-1`", report)
        self.assertIn("Candidate", report)

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest

from pydantic import ValidationError


SCRIPTS = (
    Path(__file__).resolve().parents[3]
    / "AgentSkills"
    / "ig-pi-controller"
    / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from ig_pi_control.normalize import normalize_request  # noqa: E402


class NormalizeRequestTests(unittest.TestCase):
    def test_fills_safe_defaults_and_generates_a_stable_agent_id(self) -> None:
        result = normalize_request(
            {"task": "分析 SCH1 换片握手失败"},
            now=datetime(2026, 8, 17, 1, 2, 3, tzinfo=timezone.utc),
            suffix="abc123",
        )

        self.assertEqual(result.agent_id, "ig-pi-expand:20260817T010203Z:abc123")
        self.assertEqual(result.max_depth, 4)
        self.assertEqual(result.max_expanded_nodes, 20)
        self.assertEqual(result.max_edges, 60)
        self.assertEqual(result.max_retries_per_node, 1)
        self.assertEqual(result.context_pack.goal, "分析 SCH1 换片握手失败")
        self.assertTrue(result.context_pack.digest)
        self.assertIn("agentId", result.auto_filled)

    def test_accepts_legacy_max_nodes_alias(self) -> None:
        result = normalize_request(
            {"goalLabel": "目标", "maxNodes": 7},
            now=datetime(2026, 8, 17, tzinfo=timezone.utc),
            suffix="abc123",
        )

        self.assertEqual(result.max_expanded_nodes, 7)

    def test_rejects_conflicting_node_limits(self) -> None:
        with self.assertRaises(ValidationError):
            normalize_request(
                {"goalLabel": "目标", "maxNodes": 2, "maxExpandedNodes": 3},
                suffix="abc123",
            )

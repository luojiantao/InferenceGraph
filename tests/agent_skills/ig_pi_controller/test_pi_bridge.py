from __future__ import annotations

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

from ig_pi_control.pi_bridge import build_pi_subagent_call  # noqa: E402


class PiBridgeTests(unittest.TestCase):
    def test_builds_a_user_scoped_single_worker_call_without_parallel_fields(self) -> None:
        action = {
            "kind": "spawn-worker",
            "reason": "claimed",
            "targetVertexId": "V1",
            "payload": {
                "protocolVersion": "ig-pi-controller/v2",
                "sessionId": "session-1",
                "vertexId": "V1",
                "workerAgentId": "test-run:step:1:attempt:0",
                "contextPack": {"version": "cp-0001"},
            },
        }

        call = build_pi_subagent_call({"state": {}, "action": action}, cwd="D:\\work")

        self.assertEqual(call["agent"], "worker")
        self.assertEqual(call["agentScope"], "user")
        self.assertEqual(call["cwd"], "D:\\work")
        self.assertNotIn("tasks", call)
        self.assertNotIn("chain", call)
        self.assertIn("vertexId", call["task"])
        self.assertIn("WorkerResult/v1", call["task"])
        self.assertNotIn("model", call)

    def test_preserves_an_explicit_model_only_when_packet_requests_one(self) -> None:
        action = {
            "kind": "spawn-researcher",
            "reason": "retrieval",
            "payload": {
                "sessionId": "session-1",
                "vertexId": "V1",
                "workerAgentId": "test-run:step:2:attempt:0",
                "retrievalRequests": [{"question": "What happened?"}],
                "requestedModel": "openai/gpt-5.2",
            },
        }

        call = build_pi_subagent_call(action, cwd="D:\\work")

        self.assertEqual(call["model"], "openai/gpt-5.2")
        self.assertIn("资料收集 Worker", call["task"])

    def test_rejects_non_dispatch_actions(self) -> None:
        with self.assertRaisesRegex(ValueError, "spawn-worker or spawn-researcher"):
            build_pi_subagent_call({"kind": "stop", "reason": "done"}, cwd="D:\\work")

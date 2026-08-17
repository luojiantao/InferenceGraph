"""Render Pi's isolated single-worker invocation from a controller action."""

from __future__ import annotations

import json
from typing import Any

from .models import NextAction


def _require_packet_value(packet: dict[str, Any], key: str) -> Any:
    value = packet.get(key)
    if value is None:
        raise ValueError(f"Pi worker packet is missing {key}")
    return value


def _compact_packet(packet: dict[str, Any]) -> str:
    return json.dumps(packet, ensure_ascii=False, indent=2, sort_keys=True)


def _build_expansion_task(packet: dict[str, Any]) -> str:
    _require_packet_value(packet, "sessionId")
    _require_packet_value(packet, "vertexId")
    _require_packet_value(packet, "workerAgentId")
    _require_packet_value(packet, "contextPack")
    return "\n".join(
        [
            "任务身份：InferenceGraph 单节点单步展开 Worker（Pi）",
            "你处于隔离的 fresh Pi 上下文。仅处理下方任务包的一个 vertexId，完成后退出。",
            "",
            "开始前加载并严格遵守 inference-graph-backward-expansion Skill。若它未进入当前上下文，",
            "且当前项目提供 AgentSkills/inference-graph-backward-expansion/SKILL.md，才读取该文件。",
            "",
            "固定规则：",
            "- 读取真实 session、目标上游 context 与 downstream context；downstream 仅用于导航，不是证据。",
            "- 只规划并写入一层直接前提。Evidence 必须可追溯，待推导命题使用 State。",
            "- 同一公式来源为 AND，不同公式为 OR；只创建 前提 -> 当前节点 的 Candidate 边。",
            "- 每次成功写入后使用返回的最新 graphRevision；发生 RevisionConflict 立即停止。",
            "- 禁止处理其他 vertexId、递归、调用 subagent、编辑文件、普通 shell 副作用，",
            "  以及 claim_vertex_expansions、set_vertex_expansion_state、claim/release/complete/block/finish/delete。",
            "",
            "只返回一个未使用 Markdown 代码围栏的紧凑 JSON 对象。不要输出解释文字。",
            "字段必须严格是 WorkerResult/v1 允许的字段：status、targetVertexId、workerAgentId、",
            "contextPackVersion、initialGraphRevision、finalGraphRevision、createdVertices、reusedVertices、",
            "formulae、nextStateVertexIds、retrievalRequests、risks、stopReason。",
            "资料不足时返回 status=needs-retrieval 和至少一个 retrievalRequests；不得编造 Evidence。",
            "",
            "任务包：",
            _compact_packet(packet),
        ]
    )


def _build_research_task(packet: dict[str, Any]) -> str:
    _require_packet_value(packet, "sessionId")
    _require_packet_value(packet, "vertexId")
    _require_packet_value(packet, "workerAgentId")
    _require_packet_value(packet, "retrievalRequests")
    return "\n".join(
        [
            "任务身份：InferenceGraph 资料收集 Worker（Pi）",
            "你处于隔离的 fresh Pi 上下文。只为任务包中的一个 vertexId 收集可追溯材料。",
            "",
            "禁止创建或编辑推理边/顶点，禁止 claim、release、complete、block、finish、delete，",
            "禁止调用 subagent、编辑文件或执行普通 shell 副作用。",
            "只返回一个未使用 Markdown 代码围栏的紧凑 JSON 对象：",
            '{"targetVertexId":"...","workerAgentId":"...","materials":[{"sourceRef":"...","excerpt":"...","sourceKind":"...","timeRange":"..."}]}',
            "materials 必须非空且每项可追溯；若找不到可追溯材料，停止并让协调者报告缺口，不要伪造结果。",
            "",
            "任务包：",
            _compact_packet(packet),
        ]
    )


def _extract_action(payload: dict[str, Any]) -> NextAction:
    """Accept an action itself or the full state-and-action CLI response."""

    candidate = payload.get("action", payload)
    if not isinstance(candidate, dict):
        raise ValueError("Pi subagent action must be an object")
    return NextAction.model_validate(candidate)


def build_pi_subagent_call(payload: dict[str, Any], *, cwd: str) -> dict[str, str]:
    """Build the exact single-task parameters accepted by Pi's subagent tool."""

    if not cwd.strip():
        raise ValueError("cwd must not be empty")
    action = _extract_action(payload)
    if action.kind not in {"spawn-worker", "spawn-researcher"}:
        raise ValueError("Pi subagent call requires spawn-worker or spawn-researcher action")
    packet = action.payload
    if action.kind == "spawn-worker":
        task = _build_expansion_task(packet)
    else:
        task = _build_research_task(packet)

    result = {
        "agent": "worker",
        "agentScope": "user",
        "cwd": cwd,
        "task": task,
    }
    requested_model = packet.get("requestedModel")
    if requested_model is not None:
        if not isinstance(requested_model, str) or not requested_model.strip():
            raise ValueError("requestedModel must be a non-empty string when provided")
        result["model"] = requested_model
    return result

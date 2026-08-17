"""Render deterministic, human-readable audit reports from RunState."""

from __future__ import annotations

from .models import RunState


def render_report(state: RunState) -> str:
    lines = [
        "## InferenceGraph 串行扩展控制器结果",
        "",
        "### 输入与范围",
        f"- sessionId：`{state.session_id}`",
        f"- 根节点：`{state.root_vertex_id}`",
        f"- agentId：`{state.agent_id}`",
        (
            "- 预算："
            f"depth={state.budget.max_depth}，nodes={state.budget.max_expanded_nodes}，"
            f"edges={state.budget.max_edges}，retries={state.budget.max_retries_per_node}"
        ),
        f"- Context Pack：`{state.context_pack.version}`（`{state.context_pack.digest}`）",
        f"- 自动补全：{', '.join(state.auto_filled) if state.auto_filled else '无'}",
        "",
        "### 执行摘要",
        "- 节点选择：由 InferenceGraph 会话策略（DFS / BFS / Priority）决定。",
        f"- 已结算扩展节点：{state.expanded_node_count}",
        f"- 观察到的新 Candidate 边：{state.created_edge_count}",
        f"- 最新 graphRevision：{state.latest_graph_revision}",
        f"- 停止条件：{state.stop_condition or '尚未停止'}",
        "",
        "### MCP 节点扩展占用",
    ]
    if state.in_flight is not None:
        lines.append(
            f"- 正在展开：`{state.in_flight.vertex_id}` "
            f"（lease=`{state.in_flight.lease_id}`，depth={state.in_flight.depth}）"
        )
    if state.pending_settlement is not None:
        lines.append(
            f"- 等待状态确认：`{state.pending_settlement.claim.vertex_id}` "
            f"→ `{state.pending_settlement.state}`"
        )
    if state.pending_retrieval is not None:
        lines.append(
            f"- 等待资料：`{state.pending_retrieval.claim.vertex_id}` "
            f"（lease=`{state.pending_retrieval.claim.lease_id}`）"
        )
    if (
        state.in_flight is None
        and state.pending_settlement is None
        and state.pending_retrieval is None
    ):
        lines.append("- 当前没有本控制器持有的节点扩展租约。")

    lines.extend(["", "### 单步记录"])
    if state.steps:
        lines.extend(
            [
                "| 序号 | 目标 | Worker | 状态 | revision | 新边 | 备注 |",
                "| --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for step in state.steps:
            revision = "-"
            if step.initial_graph_revision is not None:
                revision = f"{step.initial_graph_revision} → {step.final_graph_revision}"
            lines.append(
                "| "
                f"{step.sequence} | `{step.target_vertex_id}` | `{step.worker_agent_id or '-'}` | "
                f"{step.status} | {revision} | {step.created_edge_delta} | {step.note or '-'} |"
            )
    else:
        lines.append("- 尚无 Worker 步骤。")

    lines.extend(["", "### 未解决前沿"])
    if state.unresolved_frontier:
        for frontier in state.unresolved_frontier:
            lines.append(f"- `{frontier.vertex_id}`：{frontier.status}；{frontier.reason}")
    else:
        lines.append("- 无。")

    lines.extend(
        [
            "",
            "### 约束确认",
            "- 当前 Skill 一次只领取一个节点；MCP 的批量领取接口已为未来并发保留。",
            "- `Expanding` 与 `AwaitingContext` 由图服务持久化，不能由本地 RunState 代替。",
            "- Candidate 结构仍需后续取证、claim 与 complete 阶段验证；图服务才是事实来源。",
        ]
    )
    return "\n".join(lines) + "\n"

"""Request normalization and initial RunState construction."""

from __future__ import annotations

from datetime import datetime, timezone
import secrets
import string
from typing import Any

from .context_pack import create_context_pack, finalize_context_pack
from .models import Budget, ContextPack, NormalizedRunRequest, RunRequest, RunState


DEFAULT_MAX_DEPTH = 4
DEFAULT_MAX_EXPANDED_NODES = 20
DEFAULT_MAX_EDGES = 60
DEFAULT_MAX_RETRIES_PER_NODE = 1


def generate_agent_id(now: datetime | None = None, suffix: str | None = None) -> str:
    instant = now or datetime.now(timezone.utc)
    token = suffix or "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    if len(token) != 6 or any(char not in string.ascii_lowercase + string.digits for char in token):
        raise ValueError("agentId suffix must contain exactly six lowercase letters or digits")
    return f"ig-codex-expand:{instant.strftime('%Y%m%dT%H%M%SZ')}:{token}"


def normalize_request(payload: dict[str, Any], *, now: datetime | None = None, suffix: str | None = None) -> NormalizedRunRequest:
    request = RunRequest.model_validate(payload)
    auto_filled: list[str] = []

    agent_id = request.agent_id
    if agent_id is None:
        agent_id = generate_agent_id(now, suffix)
        auto_filled.append("agentId")

    max_depth = request.max_depth
    if max_depth is None:
        max_depth = DEFAULT_MAX_DEPTH
        auto_filled.append("maxDepth")

    max_expanded_nodes = request.max_expanded_nodes
    if max_expanded_nodes is None:
        max_expanded_nodes = DEFAULT_MAX_EXPANDED_NODES
        auto_filled.append("maxExpandedNodes")

    max_edges = request.max_edges
    if max_edges is None:
        max_edges = DEFAULT_MAX_EDGES
        auto_filled.append("maxEdges")

    max_retries = request.max_retries_per_node
    if max_retries is None:
        max_retries = DEFAULT_MAX_RETRIES_PER_NODE
        auto_filled.append("maxRetriesPerNode")

    context_pack = request.context_pack
    if context_pack is None:
        goal = request.goal_label or request.task or "反向展开当前用户请求（自动创建）"
        context_pack = create_context_pack(goal)
        auto_filled.append("contextPack")
    else:
        context_pack = finalize_context_pack(context_pack)

    return NormalizedRunRequest(
        sessionId=request.session_id,
        vertexId=request.vertex_id,
        agentId=agent_id,
        maxDepth=max_depth,
        maxExpandedNodes=max_expanded_nodes,
        maxEdges=max_edges,
        maxRetriesPerNode=max_retries,
        goalLabel=request.goal_label,
        model=request.model_name,
        contextPack=context_pack,
        allowRetrieval=request.allow_retrieval,
        autoFilled=auto_filled,
    )


def initialize_run(
    request: NormalizedRunRequest,
    *,
    session_id: str,
    root_vertex_id: str,
    graph_revision: int,
) -> RunState:
    if graph_revision < 0:
        raise ValueError("graphRevision must not be negative")
    return RunState(
        runId=request.agent_id,
        sessionId=session_id,
        rootVertexId=root_vertex_id,
        agentId=request.agent_id,
        requestedModel=request.model_name,
        allowRetrieval=request.allow_retrieval,
        latestGraphRevision=graph_revision,
        budget=Budget(
            maxDepth=request.max_depth,
            maxExpandedNodes=request.max_expanded_nodes,
            maxEdges=request.max_edges,
            maxRetriesPerNode=request.max_retries_per_node,
        ),
        contextPack=request.context_pack,
        autoFilled=request.auto_filled,
    )

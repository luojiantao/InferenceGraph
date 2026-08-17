"""Build concise, versioned task packets for Pi workers."""

from __future__ import annotations

from .models import ClaimedExpansion, GraphSnapshot, PendingRetrieval, RunState


PROTOCOL_VERSION = "ig-pi-controller/v2"


def derive_worker_agent_id(state: RunState, claim: ClaimedExpansion) -> str:
    return f"{state.agent_id}:step:{len(state.steps) + 1}:attempt:{claim.attempts}"


def build_worker_packet(state: RunState, claim: ClaimedExpansion, snapshot: GraphSnapshot) -> dict[str, object]:
    worker_agent_id = derive_worker_agent_id(state, claim)
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "role": "InferenceGraph 单节点单步展开 Worker（Pi）",
        "sessionId": state.session_id,
        "vertexId": claim.vertex_id,
        "expansionLeaseId": claim.lease_id,
        "expansionDepth": claim.depth,
        "workerAgentId": worker_agent_id,
        "graphRevision": snapshot.graph_revision,
        "requestedModel": state.requested_model,
        "contextPack": state.context_pack.model_dump(mode="json", by_alias=True),
        "limits": {
            "maxDepth": state.budget.max_depth,
            "maxEdges": state.budget.max_edges,
            "remainingEdgeBudget": snapshot.remaining_edge_budget,
        },
        "scope": "只展开该 vertexId 的一层直接前提；不得递归。",
        "semanticConstraints": [
            "先读取 session、上游 context 与 downstream context；downstream 不是证据。",
            "Evidence 必须可追溯；待推导命题使用 State。",
            "同一公式内来源为 AND；不同公式为 OR。",
            "只创建 前提 -> 当前节点 的 Candidate 边。",
            "每次写入后采用最新 graphRevision；RevisionConflict 立即返回。",
        ],
        "forbidden": [
            "其他 vertexId",
            "递归或启动 Agent",
            "文件编辑或普通 shell 副作用",
            "claim_vertex_expansions/set_vertex_expansion_state/claim/release/complete/block/finish/delete",
        ],
        "responseContract": {
            "schema": "WorkerResult/v1",
            "required": [
                "status",
                "targetVertexId",
                "workerAgentId",
                "contextPackVersion",
                "initialGraphRevision",
                "finalGraphRevision",
            ],
            "needsRetrieval": "资料不足时返回 needs-retrieval 与 retrievalRequests，不得编造 Evidence。",
        },
    }


def build_research_packet(state: RunState, pending: PendingRetrieval) -> dict[str, object]:
    claim = pending.claim
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "role": "InferenceGraph 资料收集 Worker（Pi）",
        "sessionId": state.session_id,
        "vertexId": claim.vertex_id,
        "expansionLeaseId": claim.lease_id,
        "workerAgentId": derive_worker_agent_id(state, claim),
        "requestedModel": state.requested_model,
        "contextPack": state.context_pack.model_dump(mode="json", by_alias=True),
        "retrievalRequests": [request.model_dump(mode="json", by_alias=True) for request in pending.requests],
        "scope": "仅收集可追溯材料；不得创建推理边或执行 claim/complete。",
        "requiredMaterialFields": ["sourceRef", "excerpt", "sourceKind", "timeRange"],
    }

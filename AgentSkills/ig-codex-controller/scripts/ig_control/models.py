"""JSON contracts used by the deterministic InferenceGraph control plane."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


AGENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
WorkerStatus = Literal[
    "committed",
    "no-op",
    "already-supported",
    "terminal",
    "revision-conflict",
    "needs-retrieval",
    "insufficient-context",
    "error",
]
ExpansionState = Literal[
    "Pending",
    "Expanding",
    "AwaitingContext",
    "Expanded",
    "Blocked",
    "NotApplicable",
]
SettlementState = Literal["Pending", "AwaitingContext", "Expanded", "Blocked"]


class StrictModel(BaseModel):
    """Reject undeclared JSON fields so protocol drift is visible immediately."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SourceFact(StrictModel):
    text: str = Field(min_length=1, max_length=2000)
    source_ref: str | None = Field(default=None, alias="sourceRef")
    scope: str | None = None
    unverified_background: bool = Field(default=False, alias="unverifiedBackground")

    @model_validator(mode="after")
    def mark_unsourced_facts(self) -> "SourceFact":
        if self.source_ref is None:
            self.unverified_background = True
        return self


class ContextPack(StrictModel):
    version: str = Field(pattern=r"^cp-[0-9]{4,}$")
    goal: str = Field(min_length=1, max_length=1500)
    scope: dict[str, str] = Field(default_factory=dict)
    definitions: dict[str, str] = Field(default_factory=dict)
    constraints: list[str] = Field(default_factory=list)
    known_facts: list[SourceFact] = Field(default_factory=list, max_length=32, alias="knownFacts")
    unknowns: list[str] = Field(default_factory=list, max_length=32)
    excluded_assumptions: list[str] = Field(
        default_factory=list, max_length=32, alias="excludedAssumptions"
    )
    digest: str | None = None


class RunRequest(StrictModel):
    session_id: str | None = Field(default=None, alias="sessionId")
    vertex_id: str | None = Field(default=None, alias="vertexId")
    agent_id: str | None = Field(default=None, alias="agentId")
    max_depth: int | None = Field(default=None, alias="maxDepth")
    max_expanded_nodes: int | Literal["unlimited"] | None = Field(
        default=None, alias="maxExpandedNodes"
    )
    max_edges: int | Literal["maximum"] | None = Field(default=None, alias="maxEdges")
    max_retries_per_node: int | None = Field(default=None, alias="maxRetriesPerNode")
    goal_label: str | None = Field(default=None, alias="goalLabel")
    model_name: str | None = Field(default=None, alias="model")
    context_pack: ContextPack | None = Field(default=None, alias="contextPack")
    allow_retrieval: bool = Field(default=False, alias="allowRetrieval")
    task: str | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_legacy_max_nodes(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        legacy = payload.pop("maxNodes", None)
        canonical = payload.get("maxExpandedNodes", payload.get("max_expanded_nodes"))
        if legacy is not None and canonical is not None and legacy != canonical:
            raise ValueError("maxNodes conflicts with maxExpandedNodes")
        if canonical is None and legacy is not None:
            payload["maxExpandedNodes"] = legacy
        return payload

    @field_validator("agent_id")
    @classmethod
    def validate_agent_id(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if len(value) > 200 or not AGENT_ID_PATTERN.fullmatch(value):
            raise ValueError("agentId must be <= 200 chars and use only letters, digits, '.', '_', ':', '-'")
        return value

    @field_validator("max_depth", "max_retries_per_node")
    @classmethod
    def validate_positive_int(cls, value: int | None) -> int | None:
        if value is not None and value <= 0:
            raise ValueError("limit must be a positive integer")
        return value

    @field_validator("max_expanded_nodes")
    @classmethod
    def validate_nodes(cls, value: int | Literal["unlimited"] | None) -> int | Literal["unlimited"] | None:
        if isinstance(value, int) and value <= 0:
            raise ValueError("maxExpandedNodes must be positive or unlimited")
        return value

    @field_validator("max_edges")
    @classmethod
    def validate_edges(cls, value: int | Literal["maximum"] | None) -> int | Literal["maximum"] | None:
        if isinstance(value, int) and value <= 0:
            raise ValueError("maxEdges must be positive or maximum")
        return value


class NormalizedRunRequest(StrictModel):
    session_id: str | None = Field(default=None, alias="sessionId")
    vertex_id: str | None = Field(default=None, alias="vertexId")
    agent_id: str = Field(alias="agentId")
    max_depth: int = Field(alias="maxDepth")
    max_expanded_nodes: int | Literal["unlimited"] = Field(alias="maxExpandedNodes")
    max_edges: int | Literal["maximum"] = Field(alias="maxEdges")
    max_retries_per_node: int = Field(alias="maxRetriesPerNode")
    goal_label: str | None = Field(default=None, alias="goalLabel")
    model_name: str | None = Field(default=None, alias="model")
    context_pack: ContextPack = Field(alias="contextPack")
    allow_retrieval: bool = Field(alias="allowRetrieval")
    auto_filled: list[str] = Field(default_factory=list, alias="autoFilled")


class Budget(StrictModel):
    max_depth: int = Field(alias="maxDepth")
    max_expanded_nodes: int | Literal["unlimited"] = Field(alias="maxExpandedNodes")
    max_edges: int | Literal["maximum"] = Field(alias="maxEdges")
    max_retries_per_node: int = Field(alias="maxRetriesPerNode")


class ClaimedExpansion(StrictModel):
    vertex_id: str = Field(alias="vertexId")
    lease_id: str = Field(alias="leaseId")
    depth: int = Field(ge=0)
    priority: float = 0
    rank: int = Field(ge=0)
    claimed_graph_revision: int = Field(alias="claimedGraphRevision", ge=0)
    attempts: int = Field(default=0, ge=0)
    initial_target_candidate_edge_count: int | None = Field(
        default=None, alias="initialTargetCandidateEdgeCount", ge=0
    )


class ExpansionClaimResponse(StrictModel):
    session_id: str = Field(alias="sessionId")
    graph_revision: int = Field(alias="graphRevision", ge=0)
    claims: list[dict[str, Any]] = Field(default_factory=list)


class ExpansionSettlementAck(StrictModel):
    session_id: str = Field(alias="sessionId")
    graph_revision: int = Field(alias="graphRevision", ge=0)
    vertex_id: str = Field(alias="vertexId")
    state: ExpansionState
    lease_id: str | None = Field(default=None, alias="leaseId")


class RetrievalRequest(StrictModel):
    question: str = Field(min_length=1)
    why: str = Field(min_length=1)
    source_kinds: list[str] = Field(min_length=1, alias="sourceKinds")


class PendingRetrieval(StrictModel):
    claim: ClaimedExpansion
    requests: list[RetrievalRequest]


class PendingSettlement(StrictModel):
    claim: ClaimedExpansion
    state: SettlementState
    outcome: str = Field(min_length=1)
    worker_agent_id: str | None = Field(default=None, alias="workerAgentId")
    reason: str | None = None
    created_edge_delta: int = Field(default=0, alias="createdEdgeDelta", ge=0)
    initial_graph_revision: int | None = Field(default=None, alias="initialGraphRevision", ge=0)
    worker_final_graph_revision: int | None = Field(
        default=None, alias="workerFinalGraphRevision", ge=0
    )
    retrieval_requests: list[RetrievalRequest] = Field(default_factory=list, alias="retrievalRequests")
    unresolved_reason: str | None = Field(default=None, alias="unresolvedReason")


class UnresolvedFrontier(StrictModel):
    vertex_id: str = Field(alias="vertexId")
    status: WorkerStatus
    reason: str = Field(min_length=1)


class StepRecord(StrictModel):
    sequence: int = Field(ge=1)
    target_vertex_id: str = Field(alias="targetVertexId")
    worker_agent_id: str | None = Field(default=None, alias="workerAgentId")
    status: str
    initial_graph_revision: int | None = Field(default=None, alias="initialGraphRevision")
    final_graph_revision: int | None = Field(default=None, alias="finalGraphRevision")
    created_edge_delta: int = Field(default=0, alias="createdEdgeDelta", ge=0)
    note: str | None = None


class RunState(StrictModel):
    schema_version: int = Field(default=2, alias="schemaVersion")
    run_id: str = Field(alias="runId")
    session_id: str = Field(alias="sessionId")
    root_vertex_id: str = Field(alias="rootVertexId")
    agent_id: str = Field(alias="agentId")
    requested_model: str | None = Field(default=None, alias="requestedModel")
    allow_retrieval: bool = Field(alias="allowRetrieval")
    latest_graph_revision: int = Field(alias="latestGraphRevision", ge=0)
    budget: Budget
    in_flight: ClaimedExpansion | None = Field(default=None, alias="inFlight")
    pending_settlement: PendingSettlement | None = Field(default=None, alias="pendingSettlement")
    pending_retrieval: PendingRetrieval | None = Field(default=None, alias="pendingRetrieval")
    attempts_by_vertex: dict[str, int] = Field(default_factory=dict, alias="attemptsByVertex")
    expanded_node_count: int = Field(default=0, alias="expandedNodeCount", ge=0)
    created_edge_count: int = Field(default=0, alias="createdEdgeCount", ge=0)
    context_pack: ContextPack = Field(alias="contextPack")
    auto_filled: list[str] = Field(default_factory=list, alias="autoFilled")
    steps: list[StepRecord] = Field(default_factory=list)
    unresolved_frontier: list[UnresolvedFrontier] = Field(default_factory=list, alias="unresolvedFrontier")
    stop_condition: str | None = Field(default=None, alias="stopCondition")


class GraphSnapshot(StrictModel):
    session_id: str = Field(alias="sessionId")
    graph_revision: int = Field(alias="graphRevision", ge=0)
    session_status: str = Field(default="active", alias="sessionStatus")
    remaining_edge_budget: int | None = Field(default=None, alias="remainingEdgeBudget", ge=0)
    target_vertex_id: str = Field(alias="targetVertexId")
    target_kind: Literal["Goal", "State", "Evidence"] = Field(alias="targetKind")
    target_sufficiently_supported: bool = Field(default=False, alias="targetSufficientlySupported")
    target_candidate_edge_count: int = Field(default=0, alias="targetCandidateEdgeCount", ge=0)
    target_expansion_state: ExpansionState = Field(alias="targetExpansionState")
    target_expansion_lease_id: str | None = Field(default=None, alias="targetExpansionLeaseId")


class WorkerVertex(StrictModel):
    vertex_id: str = Field(alias="vertexId")
    kind: Literal["State", "Evidence"]
    reference_id: str | None = Field(default=None, alias="referenceId")


class WorkerFormula(StrictModel):
    formula_id: str = Field(alias="formulaId")
    edge_ids: list[str] = Field(alias="edgeIds")
    source_vertex_ids: list[str] = Field(alias="sourceVertexIds")
    target_vertex_id: str = Field(alias="targetVertexId")


class WorkerResult(StrictModel):
    status: WorkerStatus
    target_vertex_id: str = Field(alias="targetVertexId")
    worker_agent_id: str = Field(alias="workerAgentId")
    context_pack_version: str = Field(alias="contextPackVersion")
    initial_graph_revision: int = Field(alias="initialGraphRevision", ge=0)
    final_graph_revision: int = Field(alias="finalGraphRevision", ge=0)
    created_vertices: list[WorkerVertex] = Field(default_factory=list, alias="createdVertices")
    reused_vertices: list[WorkerVertex] = Field(default_factory=list, alias="reusedVertices")
    formulae: list[WorkerFormula] = Field(default_factory=list)
    next_state_vertex_ids: list[str] = Field(default_factory=list, alias="nextStateVertexIds")
    retrieval_requests: list[RetrievalRequest] = Field(default_factory=list, alias="retrievalRequests")
    risks: list[str] = Field(default_factory=list)
    stop_reason: str | None = Field(default=None, alias="stopReason")

    @model_validator(mode="after")
    def validate_status_payload(self) -> "WorkerResult":
        if self.final_graph_revision < self.initial_graph_revision:
            raise ValueError("finalGraphRevision cannot be older than initialGraphRevision")
        if self.status == "needs-retrieval" and not self.retrieval_requests:
            raise ValueError("needs-retrieval requires retrievalRequests")
        return self


class ResearchMaterial(StrictModel):
    source_ref: str = Field(min_length=1, alias="sourceRef")
    excerpt: str = Field(min_length=1)
    source_kind: str = Field(min_length=1, alias="sourceKind")
    time_range: str | None = Field(default=None, alias="timeRange")


class ResearchResult(StrictModel):
    target_vertex_id: str = Field(alias="targetVertexId")
    worker_agent_id: str = Field(alias="workerAgentId")
    materials: list[ResearchMaterial] = Field(min_length=1)


class NextAction(StrictModel):
    kind: Literal[
        "claim-vertex-expansions",
        "request-graph-snapshot",
        "spawn-worker",
        "spawn-researcher",
        "set-vertex-expansion-state",
        "stop",
    ]
    reason: str = Field(min_length=1)
    target_vertex_id: str | None = Field(default=None, alias="targetVertexId")
    payload: dict[str, Any] = Field(default_factory=dict)

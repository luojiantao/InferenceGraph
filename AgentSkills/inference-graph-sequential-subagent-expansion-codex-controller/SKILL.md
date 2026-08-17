---
name: inference-graph-sequential-subagent-expansion-codex-controller
description: 使用 Codex Worker、InferenceGraph MCP 与内置 Python 控制平面，串行地把 Goal 或 State 展开为可审计的 Candidate 前提图。用于用户明确要求受预算、revision 校验、节点扩展 lease、资料缺口管理和可恢复编排的复杂推理；仅在用户显式调用此 Skill 时使用。
---

# InferenceGraph 串行节点扩展控制器（Codex）

使用本 Skill 目录中的 `scripts/ig_controller.py` 管理请求规范化、预算、Worker 结果校验、结算和报告。把 InferenceGraph 保持为图事实、节点调度顺序与租约状态的唯一来源。

当前控制器一次只展开一个节点；图服务的 `maxVertices` 与持久化 lease 已为未来并发扩展准备好。

## 前置条件

1. 确认当前运行时同时提供实际可用的 InferenceGraph MCP 工具、`collaboration.spawn_agent` 和等待 Worker 结果的能力。
2. 先读取 MCP 工具说明并映射名称。以下示例使用 `claim_vertex_expansions` 与 `set_vertex_expansion_state`；若运行时带 `inference_graph_` 前缀，使用实际名称。
3. 缺少 session、图快照、节点上下文、Candidate 写入或 MCP 工具时，停止并报告缺口；不得猜测调用或伪造图状态。
4. 不要让 Python 直接调用 MCP 或协作工具。由 Codex 调用真实工具，再把真实 JSON 传给 Python 子命令。

## 节点扩展生命周期

图服务为每个 Goal/State 持久化一个节点扩展状态：

```text
Pending -> Expanding -> Expanded
                    -> AwaitingContext -> Pending
                    -> Blocked
Evidence -> NotApplicable
```

- 只有 `Expanding` 与 `AwaitingContext` 持有独占 lease；后者用于资料收集期间保留节点。
- `claim_vertex_expansions` 原子地选择并标记 `Expanding`。它始终使用会话已保存的 `DFS`、`BFS` 或 `Priority` 策略，调用者不得提供本地队列或覆盖策略。
- `set_vertex_expansion_state` 必须带匹配的 `leaseId` 和最新 `baseGraphRevision`。除 `AwaitingContext` 外，结算会释放 lease。
- lease 过期时，下一次领取会由图服务原子地回收为 `Pending`。
- `list_candidate_edges` 是后续边执行前沿，不是节点反向展开前沿；不要用它决定下一个父节点。

## 串行编排流程

所有控制器输入与输出都是 JSON。将每一步返回的 `RunState` 保存到 `.inference-graph/runs/<run-id>.json`；恢复前必须重新读取图服务。

```text
normalize
  -> 创建或读取真实 session、根节点和图快照
  -> initialize
  -> next
  -> MCP claim_vertex_expansions(maxVertices=1)
  -> 读取被领取节点的真实快照
  -> accept-claim
  -> spawn Worker
  -> 读取新鲜图快照
  -> reconcile
  -> MCP set_vertex_expansion_state
  -> ack-settlement
  -> next
```

按以下顺序执行：

1. 运行 `normalize`，再创建或读取 session。用真实 `sessionId`、根 `vertexId`、`graphRevision` 调用 `initialize`。
2. 调用 `next`。若返回 `claim-vertex-expansions`，把 action 的 payload 原样传给 MCP；该 payload 固定 `maxVertices=1`。
3. 对每个 MCP claim，使用 `get_reasoning_context`、`get_vertex` 等真实图响应构造目标快照。快照必须包含目标节点、直接 Candidate 边计数、会话状态、剩余边预算、扩展状态和 leaseId。
4. 调用 `accept-claim`。仅当 MCP claim 与快照中的 `Expanding` 和同一 lease 完全匹配时，才执行返回的 `spawn-worker`。
5. Worker 返回后，先读取新鲜目标快照，再调用 `validate-worker-result` 和 `reconcile`。
6. `next` 会给出 `set-vertex-expansion-state`。调用 MCP 后，把真实响应传给 `ack-settlement`；未确认前不得领取下一节点。
7. 若状态为 `AwaitingContext`，先 ack 保留 lease，再启动唯一的资料收集 Worker。资料回来后调用 `reconcile-research`，按 action 将该节点结算回 `Pending`，再由 MCP 重新选择。
8. `next` 返回 `stop` 后调用 `report`。空的节点扩展前沿只表示规划停止，绝不表示 Goal 已被证明。

常用命令：

```text
python scripts/ig_controller.py normalize --request <request.json>
python scripts/ig_controller.py initialize --request <normalized.json> --session <session.json>
python scripts/ig_controller.py next --state <state.json>
python scripts/ig_controller.py accept-claim --state <state.json> --claim <mcp-claim.json> --snapshot <target-snapshot.json>
python scripts/ig_controller.py reconcile --state <state.json> --snapshot <target-snapshot.json> --worker-result <worker.json>
python scripts/ig_controller.py ack-settlement --state <state.json> --settlement <mcp-settlement.json>
python scripts/ig_controller.py reconcile-research --state <state.json> --research-result <research.json>
python scripts/ig_controller.py report --state <state.json>
```

## Worker 边界

为 `spawn-worker` 使用 `agent_type="worker"` 和 `fork_turns="none"`。当前 Skill 中，在一个节点的 settlement 被 MCP 确认前不得启动第二个扩展或资料收集 Worker。

扩展 Worker 必须：

- 只展开分配的一个 `vertexId` 的一层直接前提；它可以一次创建多个直接前提和多个 Candidate 边。
- 先读取真实 session、目标上游 context 和 downstream context。downstream 只用于导航，不是证据。
- 将可追溯直接材料建为 Evidence，将待推导命题建为 State；同一公式的来源表示 AND，不同公式表示 OR。
- 只创建 `前提 -> 当前节点` 的 Candidate 边，并在每次写入后使用最新 `graphRevision`。
- 遇到 revision 冲突立即返回 `revision-conflict`；资料不足时返回带 `retrievalRequests` 的 `needs-retrieval`，不得编造 Evidence。

禁止 Worker 递归展开、启动 Agent、编辑文件、执行普通 shell 副作用，以及调用 `claim_vertex_expansions`、`set_vertex_expansion_state`、边的 claim/release/complete/block、finish 或 delete。

## 图语义约束

- Candidate、下游路径、Goal 可达性和计划文本都不是已证明结论。
- 只以图服务真实返回的顶点、边、公式、节点扩展状态和 revision 推进状态；不得采用 Worker 自报的下一节点 ID。
- Context Pack 是范围和背景。没有来源的内容只能是未核实背景，不能升级为 Evidence。
- 资料收集 Worker 必须返回可追溯 URI/路径、摘录、时间范围和来源类型；没有可追溯材料的总结不是证据。

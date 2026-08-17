---
name: ig-pi-controller
description: 使用 Pi Coding Agent 的 user-level worker、InferenceGraph MCP 与内置 Python 控制平面，串行地把 Goal 或 State 展开为可审计的 Candidate 前提图。用于用户明确要求受预算、revision 校验、节点扩展 lease、资料缺口管理和可恢复编排的复杂推理；仅在用户显式调用此 Skill 时使用。
---

# InferenceGraph 串行节点扩展控制器（Pi）

Pi 的 `subagent` 扩展负责启动隔离上下文的 fresh `worker`；本目录的 Python 只负责 JSON 状态机、输入校验、任务包和 Pi 单任务调用参数。InferenceGraph 是图事实、遍历策略和节点扩展 lease 的唯一来源。

当前控制器一次只领取并展开一个节点。`inFlight`、`pendingSettlement` 与 `pendingRetrieval` 会显式标记控制器正在处理的节点，为未来并发扩展保留协议空间。

## 名称说明

`ig` 是 `InferenceGraph` 的简写；`pi-controller` 表示 Pi Agent 上的串行节点扩展控制器。完整行为、约束和 MCP 图协议不因缩写而改变。

## 加载与运行时预检

本目录位于 `AgentSkills/` 时，Pi 不会自动发现它。通过 `pi --skill <此目录绝对路径>` 启动，或将其父目录加入 Pi 的 `settings.json` 的 `skills` 配置后，显式执行：

```text
/skill:ig-pi-controller <任务与运行参数>
```

领取任何 lease 前，确认当前 Pi 会话的真实能力：

1. `subagent` 工具可用，且支持单任务参数 `agent`、`task`、`agentScope`、`cwd`。
2. 用户级 Agent 列表有 `worker`；固定使用 `agentScope: "user"`，不加载项目级 Agent。
3. 映射实际可用的 InferenceGraph MCP 工具：session/vertex/context 读取、Candidate 写入、`claim_vertex_expansions` 与 `set_vertex_expansion_state`。工具名可能带 `inference_graph_` 前缀。
4. 任一能力缺失时停止并报告。不要凭 `pi --version`、本地目录或猜测的 MCP 名称判断可用性；尤其不要先领取 lease。

Python 不直接调用 MCP 或 Pi 工具。Pi 协调者调用真实工具，再把真实 JSON 传给本 Skill 的命令。

## 节点扩展生命周期

```text
Pending -> Expanding -> Expanded
                    -> AwaitingContext -> Pending
                    -> Blocked
Evidence -> NotApplicable
```

- 只有 `Expanding` 与 `AwaitingContext` 持有独占 lease。
- `claim_vertex_expansions` 原子地依据会话已持久化的 `DFS`、`BFS` 或 `Priority` 策略选择节点。不得维护本地队列或覆盖服务端策略。
- `set_vertex_expansion_state` 必须使用匹配 `leaseId` 和最新 `baseGraphRevision`；除 `AwaitingContext` 外，结算会释放 lease。
- `list_candidate_edges` 是后续边执行前沿，不是反向节点选择器。

## 串行编排

所有控制器输入和输出都是 JSON。将每步返回的 `RunState` 保存至 `.inference-graph/runs/<run-id>.json`；恢复前必须重新读取图服务。

```text
normalize
  -> 创建或读取真实 session、根节点和图快照
  -> initialize
  -> next
  -> MCP claim_vertex_expansions(maxVertices=1)
  -> 读取被领取节点的真实快照
  -> accept-claim
  -> build-pi-subagent-call
  -> Pi subagent 单任务 Worker
  -> 读取新鲜图快照
  -> reconcile
  -> MCP set_vertex_expansion_state
  -> ack-settlement
  -> next
```

1. 运行 `normalize`，创建或读取真实 session，再用服务返回的 `sessionId`、根 `vertexId`、`graphRevision` 调用 `initialize`。
2. 调用 `next`。若 action 是 `claim-vertex-expansions`，原样调用 MCP；控制器固定 `maxVertices=1`。
3. 对 claim 读取真实目标快照。快照必须含目标节点、直接 Candidate 边计数、会话状态、剩余边预算、扩展状态和 leaseId。
4. 调用 `accept-claim`。只有 claim、快照中的 `Expanding` 和同一 lease 完全一致时，才继续。
5. 将 `accept-claim` 的完整 JSON 输出传给 `build-pi-subagent-call`。它会抽取 action 并生成唯一允许的 Pi 单任务调用参数；将该 JSON 对象原样传给 `subagent`。
6. 等待 Worker 的最终 JSON。读取新鲜目标快照后调用 `reconcile`。由 `next` 返回 `set-vertex-expansion-state` 后调用 MCP，并将真实响应传给 `ack-settlement`。
7. `AwaitingContext` 先确认并保留 lease，再用相同方式启动唯一资料收集 Worker；有可追溯材料后调用 `reconcile-research`，按 action 将节点结算回 `Pending`。
8. settlement 未确认前不得领取下一节点。`next` 返回 `stop` 后调用 `report`；空前沿只是规划停止，不表示 Goal 已证明。

常用命令：

```text
python scripts/ig_controller.py normalize --request <request.json>
python scripts/ig_controller.py initialize --request <normalized.json> --session <session.json>
python scripts/ig_controller.py next --state <state.json>
python scripts/ig_controller.py accept-claim --state <state.json> --claim <mcp-claim.json> --snapshot <target-snapshot.json>
python scripts/ig_controller.py build-pi-subagent-call --action <accept-claim-output.json> --cwd <当前工作目录>
python scripts/ig_controller.py reconcile --state <state.json> --snapshot <target-snapshot.json> --worker-result <worker.json>
python scripts/ig_controller.py ack-settlement --state <state.json> --settlement <mcp-settlement.json>
python scripts/ig_controller.py reconcile-research --state <state.json> --research-result <research.json>
python scripts/ig_controller.py report --state <state.json>
```

## Pi Worker 桥接与边界

`build-pi-subagent-call` 输出固定使用 Pi 的单任务形式：

```json
{
  "agent": "worker",
  "agentScope": "user",
  "cwd": "<当前工作目录>",
  "task": "<由控制器生成的短任务包>"
}
```

仅当用户显式指定 model 时才加入 `model`。绝不使用 `tasks` 并行模式或 `chain` 模式，也不向同一 Worker 塞入多个节点。

生成的 Worker 任务会强制：

- 只展开分配的一个 `vertexId` 的一层直接前提；可一次创建多个直接前提和 Candidate 边。
- 先读取真实 session、上游 context 和 downstream context；downstream 只导航，不能作为证据。
- 将可追溯材料建为 Evidence、待推导命题建为 State；同一公式来源表示 AND，不同公式表示 OR。
- 只创建 `前提 -> 当前节点` Candidate 边，每次写入采用最新 `graphRevision`。
- 遇到 revision 冲突立即返回 `revision-conflict`；资料不足返回 `needs-retrieval` 和 `retrievalRequests`，不得编造 Evidence。
- 先加载已安装的 `inference-graph-backward-expansion` Skill；仅在当前项目提供它且未自动加载时，回退读取 `AgentSkills/inference-graph-backward-expansion/SKILL.md`。

禁止 Worker 递归展开、调用 `subagent`、编辑文件、执行普通 shell 副作用，以及调用节点扩展 lease、边的 claim/release/complete/block、finish 或 delete。资料收集 Worker 必须返回带 URI/路径、摘录、时间范围和来源类型的材料；没有可追溯材料时不要调用 `reconcile-research`。

## 图语义约束

- Candidate、下游路径、Goal 可达性和计划文本都不是已证明结论。
- 仅以图服务真实返回的顶点、边、公式、节点扩展状态和 revision 推进状态为准；不得采用 Worker 自报的下一节点 ID。
- Context Pack 是范围和背景。无来源内容只能是未核实背景，不能升级为 Evidence。
- `Expanding` 与 `AwaitingContext` 的持有关系由图服务持久化；本地 `RunState` 仅记录本控制器已验证的处理状态。

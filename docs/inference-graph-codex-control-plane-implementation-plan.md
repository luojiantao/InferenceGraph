# InferenceGraph Codex 控制平面：节点 lease 与 MCP 调度方案

## 1. 目标

将“下一个要展开哪个节点”的决定从 Python 本地队列迁移到 InferenceGraph 服务。服务端持久化每个节点的扩展状态，并在领取时原子地标记正在展开的节点，为未来并发 Worker 留出安全边界。

当前 Codex Skill 保持串行：一次领取一个节点、启动一个 Worker、由 MCP 确认结算后才领取下一节点。服务端已经支持批量领取，因此未来并发不需要改变图模型或数据库。

- InferenceGraph 是图、会话策略、节点状态和 revision 的唯一事实来源。
- 会话保存的 `DFS`、`BFS` 或 `Priority` 决定下一个节点；控制器不得维护或覆盖本地遍历队列。
- 一个 Worker 只扩展一个父节点的一层直接前提，但可一次创建多个直接前提和多个 Candidate 边。
- Candidate 只是待执行的推理关系，不是已证明结论。

## 2. 责任划分

| 组件                        | 负责                                                           | 不负责                            |
| --------------------------- | -------------------------------------------------------------- | --------------------------------- |
| InferenceGraph Core/Storage | 节点扩展状态、lease、策略排序、原子领取、结算、事件与 revision | 领域语义推理                      |
| Codex 协调器                | 调用真实 MCP、保存控制器状态、启动/等待 Worker                 | 自己选择下一个图节点              |
| Skill 内 Python 控制器      | 参数默认值、预算、MCP/Worker 校验、重试、结算编排、报告        | 访问 MCP、维护 BFS/DFS 队列、写图 |
| Codex Worker                | 单节点的直接前提规划、State/Evidence、AND/OR、受限图写入       | 递归扩展、节点领取/结算、并发调度 |

## 3. 服务端状态模型

每个 `Goal` 与 `State` 有一条 `vertex_expansions` 记录：

    Pending -> Expanding -> Expanded
                        -> AwaitingContext -> Pending
                        -> Blocked
    Evidence -> NotApplicable

`Expanding` 与 `AwaitingContext` 必须带唯一的 `VertexExpansionLease`；其它状态不得带 lease。

    vertex_expansions
      session_id, vertex_id, state
      lease_id, agent_id, acquired_at, expires_at
      reason, updated_at, updated_at_revision

新建 Goal/State 默认 `Pending`，Evidence 默认 `NotApplicable`。会话结束时，仍在 `Expanding` 或 `AwaitingContext` 的节点转为 `Blocked`，避免遗留伪活跃任务。

兼容迁移在已有数据库补齐缺失记录：旧 Goal/State 写入 `Pending`，旧 Evidence 写入 `NotApplicable`。已有状态和活动 lease 不会被覆盖。

## 4. MCP 契约

### `claim_vertex_expansions`

该工具在 SQLite `BEGIN IMMEDIATE` 事务内完成以下动作：回收过期 lease、计算候选顺序、领取最多 N 个节点、写入 `Expanding` 和审计事件。其他协调器因此不能重复领取同一节点。

输入：

    sessionId, baseGraphRevision, agentId
    rootVertexId?、maxVertices、maxDepth?、leaseSeconds?

不提供 `strategy` 参数。排序始终读取 `session.strategy`，避免同一会话被不同协调器按不同算法调度。

输出的每个 claim 包含 `vertex`、`expansion`、`leaseId`、反向深度、priority 与稳定 rank。它与之后读取的图快照共同授权启动 Worker。

### `set_vertex_expansion_state`

只能由当前 lease owner 调用，并需要匹配的 `baseGraphRevision`、`vertexId`、`leaseId` 和以下状态之一：`Pending`、`AwaitingContext`、`Expanded`、`Blocked`。

`AwaitingContext` 保留 lease；其它目标状态释放 lease。Python 控制器只有收到 MCP 真实响应后，才能清理本地 `pendingSettlement`。

## 5. 节点选择算法

推理边方向是 `premise -> target`；反向规划从目标沿入边走向前提。图服务计算 `Pending` Goal/State 的反向深度，排除 Evidence、终态/活动节点以及 `maxDepth` 外节点。

| 策略     | 首要排序                    | 次要排序                       |
| -------- | --------------------------- | ------------------------------ |
| DFS      | 深度大的节点优先            | priority 高、vertexId 稳定顺序 |
| BFS      | 深度小的节点优先            | priority 高、vertexId 稳定顺序 |
| Priority | 被有效边消费的最高 priority | 深度小、vertexId 稳定顺序      |

`list_candidate_edges` 是已提出边的执行前沿；它不是反向节点扩展前沿。

## 6. Python 控制器与目录

控制器是本 Skill 的专属资源，随 Skill 一起安装、移动和升级：

    AgentSkills/inference-graph-sequential-subagent-expansion-codex-controller/
      SKILL.md
      scripts/ig_controller.py
      scripts/ig_control/{models,scheduler,reconcile,packet,normalize,context_pack,report}.py

测试仍在仓库统一的 `tests/agent_skills/` 入口，便于 CI 发现和执行。当前不抽取通用 `src/` 模块。

`RunState` 不含 `queue` 或 `visited`，只保存：

- 当前服务端 claim 的 `inFlight`（节点、lease、深度、尝试次数）；
- 等待 MCP 确认的 `pendingSettlement`；
- 等待资料且仍持有 lease 的 `pendingRetrieval`；
- 预算、revision、重试计数、Context Pack、审计步骤和未解决节点。

`next` 只能返回桥接动作：`claim-vertex-expansions`、`request-graph-snapshot`、`spawn-worker`、`spawn-researcher`、`set-vertex-expansion-state`、`stop`。它绝不返回本地选出的子节点。

## 7. 串行时序

    normalize -> 创建/读取真实 session 与根节点 -> initialize
    -> next -> MCP claim_vertex_expansions(maxVertices=1)
    -> 读取真实目标快照 -> accept-claim -> spawn Worker
    -> 读取新鲜快照 -> reconcile
    -> MCP set_vertex_expansion_state -> ack-settlement -> next

目标快照必须由真实 `get_reasoning_context`、`get_vertex` 等响应构建，并包含：目标节点、直接 Candidate 边计数、会话状态、剩余边预算、扩展状态和 leaseId。

对于 `needs-retrieval`：先结算为 `AwaitingContext` 并保留 lease；资料 Worker 返回后更新 Context Pack，再以同一 lease 结算为 `Pending`；之后再次调用 `claim_vertex_expansions`，由服务端重新选择节点。

## 8. 并发演进

当前 Skill 固定请求 `maxVertices=1`。未来控制器可请求 `maxVertices > 1`，为每个 claim 创建独立 Worker。服务端已保证：

- 同一批次内的节点彼此不同；
- 其他协调器不会看到这些 `Expanding` 节点；
- 每个 lease 单独校验 owner、id、到期时间和 revision；
- 过期 lease 在下一次领取时安全回到 `Pending`。

并发版本仍需单独定义 Worker 数量上限、预算分配与最终结算冲突策略；当前串行 Skill 不会自动启用并发。

## 9. 验证

至少覆盖以下行为：默认状态与旧数据回填；DFS/BFS/Priority 的不同选择；批量领取与其他协调器去重；`AwaitingContext` lease 保留/释放；Worker 不能用自报节点绕过 MCP；revision 冲突、重试、资料收集和结算确认。

推荐命令：

    pnpm typecheck
    pnpm test
    python -X utf8 -m unittest discover -s tests\agent_skills\inference_graph_sequential_subagent_expansion_codex_controller -p test_*.py -v
    python -X utf8 C:\Users\Jon\.codex\skills\.system\skill-creator\scripts\quick_validate.py AgentSkills\inference-graph-sequential-subagent-expansion-codex-controller
    git diff --check

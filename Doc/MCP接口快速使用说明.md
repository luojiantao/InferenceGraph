# InferenceGraph MCP 接口快速使用说明

本文面向调用 InferenceGraph 的 Agent、MCP Host 和运维人员。内容以当前运行中的
`/health`、`/api/tools` 以及源码中的工具注册和 Zod Schema 为准：服务通过 Streamable HTTP
提供 26 个 MCP 工具，用于记录、调度、校验和手动校正证据推理图；服务不会自行生成领域事实或结论。

完整的协议握手、所有字段范围和 Node SDK 示例见
[MCP 接入与使用指南](MCP接入与使用指南.md)。

## 1. 先建立正确的概念

| 概念               | 含义                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| MCP transport 会话 | HTTP `initialize` 后由服务端发放的 `Mcp-Session-Id`。它只维持客户端与 `/mcp` 的协议连接，服务重启后失效。 |
| 推理图会话         | `create_reasoning_session` 创建的 `sessionId`。它是持久化的业务任务标识，保存在 SQLite 中。               |
| 会话元数据         | `alias` 和 `tags` 是会话的人类可读名称与标记；不替代也不改变顶点/边的 `Vn` / `En` 正式索引。              |
| 顶点               | `Goal`、`State`、`Evidence` 三种结构角色。创建后服务分配稳定的 `V1`、`V2` 等引用。                        |
| 推理边             | 一条独立的有向关系，创建后服务分配稳定的 `E1`、`E2` 等引用。每条边有自己的状态、证据问题、租约和结论。    |
| 图版本             | `graphRevision` 是写入图时使用的乐观并发版本；写成功后必须使用响应中的新值继续写。                        |
| 事件游标           | `eventSeq` 仅用于 `get_reasoning_context` 的增量事件分页，不能替代 `graphRevision`。                      |

## 2. 启动与连接

开发环境启动：

```bash
pnpm server:dev
curl http://127.0.0.1:8791/health
```

生产启动：

```bash
pnpm build
pnpm --filter @reasoner/server start
```

默认连接信息：

| 项目          | 值                                                         |
| ------------- | ---------------------------------------------------------- |
| MCP URL       | `http://127.0.0.1:8791/mcp`                                |
| 传输方式      | MCP Streamable HTTP JSON-RPC                               |
| 默认地址/端口 | `127.0.0.1:8791`                                           |
| 认证          | 当前未提供认证；不要直接暴露到不受信任网络                 |
| stdio         | 当前不提供 stdio server                                    |
| 持久化        | `REASONER_DATA_DIR/reasoner.db`，默认 `./data/reasoner.db` |

支持 URL 型 MCP 配置的 Host 可使用：

```toml
[mcp_servers.inference_graph]
url = "http://127.0.0.1:8791/mcp"
enabled = true
```

原始 HTTP 客户端必须按 MCP 生命周期调用：

```text
POST /mcp initialize
  -> 保存响应头 Mcp-Session-Id 和协商的 Mcp-Protocol-Version
POST /mcp notifications/initialized
POST /mcp tools/list 或 tools/call
DELETE /mcp
```

`/api/tools/:tool` 是 Web UI 和诊断脚本可用的直接 JSON bridge，不是 MCP transport。
MCP Host 应连接 `/mcp`，不要把 `/health`、`/api/tools` 或根路径配置成 MCP 地址。

## 3. 26 个工具如何选择

| 分组   | 工具                                               | 何时使用                                                               |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------- |
| 会话   | `create_reasoning_session`                         | 创建持久化推理任务、Goal 顶点，并可附带别名和标签。                    |
| 会话   | `get_reasoning_session`、`list_reasoning_sessions` | 查询一个或多个会话状态、别名、标签、预算和版本。                       |
| 会话   | `update_reasoning_session_metadata`                | 替换会话别名和标签；不会改变既有 `Vn` / `En`。                         |
| 会话   | `delete_reasoning_session`                         | 通过版本校验和 `confirm:true` 后删除整个 SQLite 会话图。               |
| 会话   | `increase_reasoning_session_edge_budget`           | 活动会话的物理边数将超过 `budget.maxEdges` 时，提高上限。              |
| 会话   | `finish_reasoning_session`                         | 已得到终态后显式结束；会把未完成的 Candidate/Leased 边置为 Abandoned。 |
| 顶点   | `add_state_vertex`                                 | 写入待推导或已经观察到的状态。                                         |
| 顶点   | `add_evidence_vertex`                              | 写入日志、源码、快照等直接证据。                                       |
| 顶点   | `get_vertex`                                       | 查询顶点及其入边、出边。                                               |
| 顶点   | `update_vertex`                                    | 校正顶点标签和 JSON 载荷；不会改写 `Vn` 或顶点类型。                   |
| 建模   | `propose_inference_edge`                           | 提出候选推理关系和每条关系的证据问题。                                 |
| 前沿   | `get_inference_edge`、`list_candidate_edges`       | 查看具体边或按 DFS/BFS/Priority 选择可处理的候选边。                   |
| 建模   | `update_inference_edge`                            | 调整边描述、成本、优先级和 Candidate 状态边的取证问题。                |
| 租约   | `claim_inference_edge`、`claim_inference_edges`    | 独占领取一条或一批候选边，并获得执行上下文与 context hash。            |
| 租约   | `release_inference_edge`                           | 暂时无法处理时放弃租约，让边回到候选前沿。                             |
| 取证   | `answer_evidence_question`                         | 对已领取边记录可审计的证据回答。                                       |
| 取证   | `complete_inference_edge`                          | 所有问题回答后，以领取时的 context hash 和结论完成边。                 |
| 取证   | `block_inference_edge`                             | 发现冲突证据或无法继续时记录阻塞原因。                                 |
| 上下文 | `get_context_for_vertex`                           | 为继续扩展某顶点获取依赖子图、证据摘要和全局概况。                     |
| 上下文 | `get_downstream_context_for_vertex`                | 获取顶点的直接出边、直接下游节点和到 Goal 的最短路径摘要。             |
| 上下文 | `get_reasoning_text_for_vertex`                    | 将某顶点的依赖子图转写为 Markdown 推理文本和 Mermaid。                 |
| 上下文 | `get_context_for_edge`                             | 读取单边执行所需的前提、问题、祖先和 `contextHash`。                   |
| 上下文 | `get_reasoning_context`                            | 同步完整快照、候选前沿、状态计数和按 `eventSeq` 分页的审计事件。       |

除 `create_reasoning_session` 外，所有写工具都必须带上：

```json
{
  "sessionId": "session-...",
  "agentId": "agent-a",
  "baseGraphRevision": 12
}
```

`delete_reasoning_session` 还必须带 `confirm: true`。删除会级联清理 SQLite 中的会话、顶点、边、事件和上下文投影；JSONL 审计文件保持追加式历史，不会随之删除。

调用 `update_reasoning_session_metadata` 的会话元数据示例：

```json
{
  "sessionId": "sched-replay-r2-car1-1786326968949",
  "agentId": "agent-a",
  "baseGraphRevision": 12,
  "alias": "R2 SwapPlan 等待 CAR1",
  "tags": ["调度", "CAR1", "根因定位"]
}
```

将 `alias` 设为 `null` 可清除别名；`delete_reasoning_session` 的调用还需把 `confirm` 设为 `true`。别名和标签只用于会话管理展示，不会改写图中已经分配的 `V1`、`E1` 等正式索引。

顶点和边的手动编辑也必须携带当前 `baseGraphRevision`。`update_vertex` 只允许更新 `label` 和 `payload`，不会改变 `Vn`、顶点类型或创建信息；任何相连的边处于 `Leased` 时必须先释放租约。`update_inference_edge` 只允许更新 `label`、`cost`、`priority` 和 Candidate 边的完整 `evidenceQuestions` 列表，不能改写 `En`、来源/目标顶点、公式组或生命周期状态；处于 `Leased` 的边不能编辑。

## 4. 图和公式语义

### 4.1 `Vn`、`En` 是正式索引

`V1`、`V2` 和 `E1`、`E2` 是会话内稳定引用，不是前端临时编号。读取和引用现有实体时，
大多数工具可接受内部 ID 或这些别名；例如 `get_vertex`、`get_context_for_vertex`、
`get_downstream_context_for_vertex`、`get_reasoning_text_for_vertex`、边查询、领取、释放、完成和阻塞。

新增顶点或边时，`vertexId` / `edgeId` 是调用方可选的内部 ID，不能传 `Vn` / `En` 格式，
以免和服务分配的正式索引冲突。

### 4.2 一条箭头就是一条独立边

`propose_inference_edge` 的来源和目标是数组，便于批量提交；服务会把来源 x 目标展开为独立二元边。
例如：

```text
sourceVertexIds: [V1, V3, V4]
targetVertexIds: [V9]

V1 -> V9 = E1
V3 -> V9 = E2
V4 -> V9 = E3
```

这三条边不会被合并，也不会生成公式中间节点。它们同属 `V9` 的一个公式组：

```text
E1 ∧ E2 ∧ E3: V1 ∧ V3 ∧ V4 -> V9
```

同一公式组内的边都完成，目标才成立；为同一目标另行提出的公式组是替代推导，任一完整组即可成立。

### 4.3 边状态不等于逻辑真值

| 状态        | 含义                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `Candidate` | 推理关系已建模，但证据尚未完成。Web 图中通常显示为虚线；它不表示已证明推理为假。 |
| `Leased`    | 某个 Agent 正在持有该边的有效租约。                                              |
| `Completed` | 证据问题已回答，且调用方用正确的 claim-time context hash 成功完成边。            |
| `Blocked`   | 已记录冲突证据或阻塞原因，边不再位于候选前沿。                                   |
| `Abandoned` | 结束会话时由服务端派生的未完成边。                                               |
| `Invalid`   | 恢复期结构校验发现问题后由服务端派生。                                           |

## 5. 一次完整推理的调用顺序

下面示例只展示 MCP `tools/call` 中的 `arguments`。原始 HTTP 调用时，应把它们包在
`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"...","arguments":...}}` 中；使用 MCP SDK
或 Host 工具调用时直接传入这些对象即可。

### 5.1 创建会话和顶点

```json
{
  "agentId": "agent-demo",
  "goalLabel": "确认设备等待原因",
  "goalPayload": { "caseId": "case-001" },
  "strategy": "Priority",
  "budget": { "maxEdges": 100, "maxLeaseSeconds": 300 }
}
```

调用 `create_reasoning_session` 后保存：

```text
session.sessionId
session.graphRevision
goalVertex.vertexId 或 goalVertex.referenceId
```

再使用当前 revision 添加状态和证据：

```json
{
  "sessionId": "session-...",
  "agentId": "agent-demo",
  "baseGraphRevision": 1,
  "label": "设备正在等待资源",
  "payload": { "device": "R2", "resource": "CAR1:1" },
  "dedupeKey": "case-001-waiting"
}
```

`add_state_vertex` 与 `add_evidence_vertex` 参数相同。每次成功写入后，都从响应读取新的
`graphRevision`，而不是继续复用旧值。

### 5.2 建模候选推理

```json
{
  "sessionId": "session-...",
  "agentId": "agent-demo",
  "baseGraphRevision": 2,
  "sourceVertexIds": ["V2", "V3"],
  "targetVertexIds": ["V1"],
  "label": "日志和快照共同支持等待原因",
  "priority": 80,
  "evidenceQuestions": [
    {
      "prompt": "日志时间窗内，资源是否确实不可用？"
    }
  ],
  "dedupeKey": "case-001-wait-cause"
}
```

响应的 `edges` 是全部展开出的独立边。每条边都有自己的 `En`、`formulaId` 和证据问题；批量展开时
不要传单一 `edgeId`。

### 5.3 领取、取证并完成

先领取候选边：

```json
{
  "sessionId": "session-...",
  "agentId": "agent-demo",
  "baseGraphRevision": 3,
  "edgeId": "E1",
  "leaseSeconds": 300
}
```

`claim_inference_edge` 返回 `leaseId` 和 `context.contextHash`。保存它们，并在租约到期前逐一回答
`edge.evidenceQuestions`：

```json
{
  "sessionId": "session-...",
  "agentId": "agent-demo",
  "baseGraphRevision": 4,
  "edgeId": "E1",
  "leaseId": "lease-...",
  "questionId": "question-...",
  "answer": "09:47:15 的日志显示 CAR1:1 为 Busy，关联快照未出现可用槽位。"
}
```

所有问题回答后完成边：

```json
{
  "sessionId": "session-...",
  "agentId": "agent-demo",
  "baseGraphRevision": 5,
  "edgeId": "E1",
  "leaseId": "lease-...",
  "inputContextHash": "claim 返回的 64 位小写 SHA-256",
  "conclusion": "该时间窗内 CAR1:1 不可用，因此该等待关系成立。"
}
```

不要以重新计算的 hash 替代 claim 返回的 `context.contextHash`。如果无法继续，使用
`release_inference_edge` 释放租约，或使用 `block_inference_edge` 记录具体阻塞原因。

### 5.4 读取结论与结束任务

```json
{
  "sessionId": "session-...",
  "vertexId": "V1",
  "policy": "DependencySubgraphWithGlobalSummary"
}
```

`get_reasoning_text_for_vertex` 返回：

```text
context        原始顶点依赖投影
reasoningText  可直接展示的 Markdown 推理文本
mermaid        可单独渲染的 Mermaid 图源码
```

需要监听全局变化时使用：

```json
{
  "sessionId": "session-...",
  "afterEventSeq": 0,
  "eventLimit": 200
}
```

后续请求使用响应中的 `nextEventSeq`，直到 `hasMoreEvents` 为 `false`。确认终态后再调用
`finish_reasoning_session`；它会清理仍未完成的候选和租约边，因此不应用于暂时的 `Verifying` 状态。

## 6. 并发、租约和重试

1. 除创建会话外，每一个写调用都以 `baseGraphRevision` 为 CAS 条件。收到 `RevisionConflict` 后，先读取会话或上下文，再以服务端返回的实际版本重试。
2. 不同边可并行领取；同一边在同一时刻只能有一个有效租约。
3. 处理时间可能超过租约时，应在创建会话时设置合适的 `budget.maxLeaseSeconds`，或重新 claim；不要使用过期的 `leaseId` 完成。
4. claim 后其他 Agent 推进无关边不会改变当前边的 claim-time context hash。当前边的材料、租约或执行者不匹配时，服务会拒绝完成。
5. `dedupeKey` 用于幂等提交。相同内容和去重键的顶点/边会复用既有实体，不额外消耗图版本。

## 7. 常见错误和处理方式

| 错误码                          | 原因                                         | 推荐动作                                                                  |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `RevisionConflict`              | 写入使用了旧 `baseGraphRevision`             | 读取实际 revision 后重试。                                                |
| `EdgeNotClaimable`              | 边不是 Candidate，或被其他有效租约占用       | 重新读取候选前沿，选择其他边或等待。                                      |
| `LeaseNotHeld` / `LeaseExpired` | 租约不属于当前 Agent 或已过期                | 重新 claim，不要复用旧 lease。                                            |
| `ContextStale`                  | `inputContextHash` 与 claim-time hash 不一致 | 使用 claim 响应中的 hash；必要时重新 claim。                              |
| `InvalidInput`                  | 字段不合法或证据问题未回答完整               | 读取 `detail.issues` 或边上的问题列表后修正。                             |
| `CycleDetected`                 | 完成边会让已完成子图形成环                   | 调整因果方向或阻塞错误边。                                                |
| `BudgetExceeded`                | 达到会话预算                                 | 用 `increase_reasoning_session_edge_budget` 提高 `maxEdges`，或结束任务。 |
| `SessionFinished`               | 会话已经终态                                 | 只读查询或创建新会话。                                                    |

MCP 工具业务错误通常以 JSON-RPC 成功 envelope 返回，但工具结果会标记 `isError: true`，
并在文本内容中携带 `{ "error": { "code", "message", "detail" } }`。客户端必须解析这个
结构化错误，不能只根据 HTTP 200 判断调用成功。

## 8. 接入检查清单

- [ ] `/health` 返回 `status: "ok"`，并显示当前工具数。
- [ ] 客户端已保存并复用 `Mcp-Session-Id`，而非把它当作推理图 `sessionId`。
- [ ] 所有写请求都使用最新的 `graphRevision`。
- [ ] 所有完成请求都使用 claim 返回的 `leaseId` 和 `context.contextHash`。
- [ ] 使用 `Vn` / `En` 时只作为已存在实体的引用，不作为新建实体的自定义 ID。
- [ ] 仅在最终结论、冲突、穷尽、预算超限或结构异常等终态调用 `finish_reasoning_session`。

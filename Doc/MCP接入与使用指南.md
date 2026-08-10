# InferenceGraph MCP 接入与使用指南

本文档以仓库当前实现为准（`@reasoner/mcp`、`@reasoner/server` `0.1.0`，MCP SDK `1.30.0`），说明外部 Agent 或 MCP Host 如何连接并使用 InferenceGraph。文档描述的是已经存在的接口，不等同于未来规划。

## 1. 先看结论

| 项目        | 当前实现                                             |
| ----------- | ---------------------------------------------------- |
| MCP 端点    | `http://127.0.0.1:8791/mcp`                          |
| 传输        | MCP Streamable HTTP；服务端开启 JSON 响应模式        |
| 工具数量    | 20 个                                                |
| 服务名/版本 | `inference-graph-reasoner` / `0.1.0`                 |
| 默认监听    | 仅回环地址 `127.0.0.1`                               |
| 鉴权        | 当前没有鉴权或 API Key                               |
| stdio 入口  | 当前没有；仓库未提供 stdio server 启动脚本           |
| 数据        | `REASONER_DATA_DIR/reasoner.db`，可选 JSONL 审计日志 |

InferenceGraph 负责记录、调度和校验证据图，不负责生成领域事实或调用 LLM。MCP server 的 instructions 也明确说明：它保存 Agent 提交的内容，执行无环、租约和 revision 约束，但不会自行发明结论。

> 安全底线：服务没有认证层。除非在受信任的内网并自行加反向代理认证，否则不要把 `REASONER_HOST` 改成公网网卡地址。服务绑定非回环地址时会写出警告，但不会替你增加认证。

## 2. 服务组成与端点

请求链路如下：

```text
MCP Host / Agent
        │ Streamable HTTP + JSON-RPC
        ▼
Fastify /mcp
        ▼
ReasonerToolController（Zod 校验与错误映射）
        ▼
ReasonerService（图、revision、租约、上下文）
        ▼
SQLite + JSONL audit
```

| 路径               | 方法                                             | 用途                                 | 是否 MCP |
| ------------------ | ------------------------------------------------ | ------------------------------------ | -------- |
| `/mcp`             | `POST`、`GET`、`DELETE`（由 SDK transport 处理） | MCP JSON-RPC 会话与工具调用          | 是       |
| `/health`          | `GET`                                            | 返回服务状态和工具数量               | 否       |
| `/api/tools`       | `GET`                                            | 返回工具名称、标题、描述和是否变更图 | 否       |
| `/api/tools/:tool` | `POST`                                           | Web UI 使用的直接 JSON bridge        | 否       |

`/api/tools/:tool` 与 MCP 共用同一个 controller，因此校验和业务语义一致；它不是 MCP 协议，不能用它代替 MCP Host 的连接地址。

若只需要验证业务 bridge，可直接发送：

```http
POST /api/tools/list_reasoning_sessions
Content-Type: application/json

{"limit":20,"includeFinished":false}
```

成功时响应就是工具值本身；错误时响应为 `{ "error": { "code", "message", "detail" } }`，并使用 HTTP 状态码表达 400/404/409/500。MCP 客户端不要把这个 bridge 当作 MCP transport。

## 3. 启动 Reasoner Server

### 3.1 环境要求

- Node.js `>=24`（项目 README 的验证版本为 `24.14.0`）。
- pnpm `11.20.0`，建议通过 Corepack 启用。

```bash
corepack enable
pnpm install
pnpm build
pnpm --filter @reasoner/server start
```

也可以直接执行构建产物：

```bash
cd apps/reasoner-server
node dist/main.js
```

启动后先检查：

```bash
curl http://127.0.0.1:8791/health
```

正常返回类似：

```json
{ "status": "ok", "tools": 20 }
```

### 3.2 服务端环境变量

| 变量                       | 默认值                | 说明                                                         |
| -------------------------- | --------------------- | ------------------------------------------------------------ |
| `REASONER_HOST`            | `127.0.0.1`           | Fastify 监听地址；改为其他地址即可能暴露未认证写接口         |
| `REASONER_PORT`            | `8791`                | HTTP 端口                                                    |
| `REASONER_DATA_DIR`        | `./data`              | SQLite 数据库和审计文件目录；目录会自动创建                  |
| `REASONER_WEB_ROOT`        | 未设置                | 设置后提供静态 Web 资源；不存在时仅记录警告并继续提供 API    |
| `REASONER_ENABLE_AUDIT`    | `true`                | 是否启用 JSONL 审计旁路                                      |
| `REASONER_LOG_LEVEL`       | `info`                | `trace`、`debug`、`info`、`warn`、`error`、`fatal`、`silent` |
| `REASONER_LOG_DIR`         | `./data/logs`         | 日志目录                                                     |
| `REASONER_LOG_FILE`        | `reasoner-server.log` | 日志文件名                                                   |
| `REASONER_LOG_ROTATE_SIZE` | `20m`                 | 单文件轮转大小                                               |
| `REASONER_LOG_RETAIN`      | `20`                  | 保留的轮转文件数量                                           |
| `REASONER_LOG_CONSOLE`     | `true`                | 是否同时输出到 stdout                                        |
| `REASONER_LOG_PRETTY`      | `false`               | 是否使用可读的 console 格式                                  |

数据目录中的主数据库文件为 `reasoner.db`。审计写入失败不会回滚已经提交的图事务，但应通过日志告警处理。

### 3.3 当前部署限制

1. `reasoner-server` 当前只装配 Streamable HTTP transport，没有 stdio transport。
2. 源码没有注册 CORS 或认证插件；浏览器端应使用同源部署或 Vite 代理，远程部署应在前置代理层加认证、TLS 和来源限制。
3. Core 提供了 `validateRecoveredSessions()` 恢复校验方法，但当前 `apps/reasoner-server/src/main.ts` 未调用它。不要在运维文档中把“启动时自动标记结构损坏会话”当成当前已生效行为；若依赖此保证，需要在启动装配中显式调用并自行验收。
4. `get_context_for_vertex` 和 `get_context_for_edge` 当前接受 `expansionHandleId`，但服务层没有单独的句柄解析工具；需要更宽投影时请显式传 `policy`（例如 `FullGraph`）。

## 4. Streamable HTTP 接入

### 4.1 会话生命周期

每个 MCP 客户端拥有独立的 MCP server/transport 对和随机 session id，但所有客户端共享同一个 ReasonerService 与 SQLite 数据。典型生命周期为：

```text
POST /mcp initialize
  └─ 响应头得到 Mcp-Session-Id
POST /mcp notifications/initialized
POST /mcp tools/list 或 tools/call
POST /mcp（后续请求均带同一个 Mcp-Session-Id）
DELETE /mcp（结束会话）
```

必须保存响应头中的 `Mcp-Session-Id`（HTTP header 不区分大小写），后续请求带上它。带未知 session id 会得到 HTTP `404`；没有 session id 且请求体不是 `initialize` 会得到 HTTP `400`。

### 4.2 手工 JSON-RPC 握手

MCP Host 通常由 SDK 自动完成下面步骤。手工调试时，`Accept` 建议同时声明 JSON 和事件流类型，以兼容 Streamable HTTP 客户端：

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:8791
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo-client","version":"1.0.0"}}}
```

响应会包含类似的头：

```http
Mcp-Session-Id: 7d4c...（随机 UUID）
Content-Type: application/json
```

随后发送初始化通知（通知没有 `id`）：

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

初始化之后的手工请求继续带上 `Mcp-Session-Id`；建议同时带上服务协商出的 `Mcp-Protocol-Version`（本例为 `2025-06-18`）。所有 `POST` 都应保留 `Content-Type: application/json` 和同时包含 `application/json, text/event-stream` 的 `Accept`。

再列出工具：

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

对应请求头示例：

```http
Mcp-Session-Id: 7d4c...
Mcp-Protocol-Version: 2025-06-18
Content-Type: application/json
Accept: application/json, text/event-stream
```

调用工具的 JSON-RPC 形状：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list_reasoning_sessions",
    "arguments": { "limit": 20, "includeFinished": false }
  }
}
```

### 4.3 MCP 返回值与错误

工具成功时，MCP result 的文本内容是 JSON 字符串，需再解析一次：

```json
{
  "result": {
    "content": [{ "type": "text", "text": "{\n  \"sessions\": []\n}" }]
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

业务拒绝不是 HTTP/JSON-RPC transport failure，而是：

```json
{
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "{\n  \"error\": {\n    \"code\": \"RevisionConflict\",\n    \"message\": \"...\",\n    \"detail\": {\"actual\": 8, \"expected\": 7}\n  }\n}"
      }
    ]
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

客户端应同时检查 `result.isError` 和文本中的 `error.code`，不能只依据 HTTP 状态码，也不能把工具拒绝当成网络断线。未知工具和 Zod 校验失败均映射为 `InvalidInput`。

### 4.4 结束会话与重连

客户端退出时，建议对 `/mcp` 发送带 `Mcp-Session-Id` 和 `Mcp-Protocol-Version` 的 `DELETE`，显式终止服务端 session。SDK 1.30.0 可调用 `transport.terminateSession()`；`transport.close()` 主要负责关闭本地连接，二者可以连续调用。若服务重启，旧 session id 不再有效；重新连接并重新 `initialize` 即可。图数据在同一 `REASONER_DATA_DIR` 下由 SQLite 保留。

## 5. MCP Host 配置示例

### 5.1 原生 Streamable HTTP 客户端

支持 URL 型 MCP server 配置的 Host 可使用下面的等价配置（具体字段名以 Host 版本为准）：

```json
{
  "mcpServers": {
    "inference-graph": {
      "url": "http://127.0.0.1:8791/mcp"
    }
  }
}
```

如果 Host 要求显式声明传输类型，可选择 `streamable-http`。本项目不提供 `command`/stdio 启动项。

### 5.2 只有 stdio 配置能力的 Host

可以在 Host 与本服务之间放置第三方 `mcp-remote` 类适配器，例如：

```json
{
  "mcpServers": {
    "inference-graph": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8791/mcp"]
    }
  }
}
```

该适配器不属于本仓库。生产环境应固定其版本、审查供应链，并确保适配器能够处理 Streamable HTTP，而不是只支持旧版 SSE。

## 6. Node.js 客户端示例

下面示例使用 MCP SDK 的 Streamable HTTP client transport；调用参数仍由服务端以 Zod 再次校验，客户端不要跳过错误处理。

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'inference-graph-demo', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8791/mcp'));

await client.connect(transport);
const listed = await client.listTools();
console.log(listed.tools.map((tool) => tool.name));

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === 'text')?.text ?? '{}';
  const value = JSON.parse(text) as Record<string, unknown>;
  if (result.isError) {
    throw new Error(JSON.stringify(value.error ?? value));
  }
  return value;
};

const created = await call('create_reasoning_session', {
  agentId: 'agent-demo',
  goalLabel: '验证一个可审计结论',
  goalPayload: { source: 'demo' },
  strategy: 'Priority',
});
console.log(created);

await transport.terminateSession();
await transport.close();
```

建议把 `sessionId`、最新 `graphRevision`、每条边的 `leaseId` 和 `contextHash` 持久化在 Agent 自己的任务状态中，不要只放在一次对话的临时变量里。

## 7. 共享数据类型与不变量

### 7.1 标识符和通用字段

所有 ID 都是不透明字符串，长度 1–200，只允许：`A-Z`、`a-z`、`0-9`、`.`、`_`、`:`、`-`。服务端生成的 ID 形如 `session-<uuid>`、`vertex-<uuid>`、`edge-<uuid>`、`lease-<uuid>`，但客户端可以在 schema 允许的位置提供稳定 ID。

所有写工具都必须带：

```json
{
  "sessionId": "session-...",
  "baseGraphRevision": 12,
  "agentId": "agent-a"
}
```

`baseGraphRevision` 是整个会话图的乐观并发 CAS 版本，不是事件游标。写成功后从返回值读取新的 `graphRevision`；同一事务产生的多个事件可能共享一个 revision。

### 7.2 顶点、推理边和状态

- 顶点 `kind`：`Goal`、`State`、`Evidence`。
- `create_reasoning_session` 自动创建一个 `Goal` 顶点。
- 每条持久化推理边都是有向二元关系：`sourceVertexIds` 和 `targetVertexIds` 各恰好有一个顶点。每条边独立保存自己的 `En`、状态、证据问题、租约和完成结论。
- `propose_inference_edge` 仍接受两个数组以便批量提交；服务会按来源 × 目标在同一事务内创建独立边，保留调用方数组顺序。例如 `[V1,V3,V4] -> [V9]` 会创建 `V1 -> V9 = E1`、`V3 -> V9 = E2`、`V4 -> V9 = E3`，不会创建中间节点或合并边。三条边同时属于 `V9` 的一个公式组，语义为 `E1 ∧ E2 ∧ E3: V1 ∧ V3 ∧ V4 -> V9`；组内必须全部完成。另一次为同一目标创建的公式组是可选推导，任一完整组都可推出目标。
- 边状态：`Candidate` → `Leased` → `Completed`，或进入 `Blocked`；释放租约回到 `Candidate`。
- `Abandoned` 由 `finish_reasoning_session` 把未完成的 `Candidate/Leased` 边派生出来；`Invalid` 由恢复期结构校验派生，二者都没有直接 MCP 写工具。
- 完成边会做环检测；会造成已完成子图环时返回 `CycleDetected`，不会写入半成品。

### 7.3 会话枚举和默认值

| 类型                     | 可选值/默认                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `goalState`              | `Exploring`、`CandidateFound`、`Verifying`、`GoalSatisfied`、`GoalConflicted`、`Exhausted`、`BudgetExceeded`、`StructurallyInvalid` |
| `strategy`               | `DFS`、`BFS`、`Priority`；创建默认 `DFS`                                                                                            |
| `projectionPolicy`       | `CurrentOnly`、`DependencySubgraph`、`DependencySubgraphWithGlobalSummary`、`FullGraph`；创建默认带全局摘要                         |
| `budget.maxEdges`        | 默认 `2000`，最大 `100000`                                                                                                          |
| `budget.maxDepth`        | 默认 `64`，最大 `1000`                                                                                                              |
| `budget.maxLeaseSeconds` | 默认 `900`（15 分钟），最大 `86400`                                                                                                 |

前沿排序是确定性的：DFS 优先深度、BFS 优先浅度、Priority 优先高 `priority`；相同条件最终按 `edgeId` 排序。

## 8. 20 个 MCP 工具参考

### 8.1 参数约定

表中 `必填` 表示调用方必须发送；`默认` 表示可省略并由服务端补齐。所有参数对象都放在 MCP `tools/call.params.arguments` 中。引用既有顶点或边时，参数同时接受内部 ID 与会话内 `Vn` / `En` 索引；服务端会在业务调用前解析为内部 ID。

#### 会话工具

| 工具                       | 变更图 | 输入                                                                                                                                                                                                                                                                       |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_reasoning_session` | 是     | `sessionId?`: ID；`agentId`: ID；`goalLabel`: string 1–400；`goalPayload?`: object，默认 `{}`；`strategy?`: enum，默认 `DFS`；`projectionPolicy?`: enum，默认 `DependencySubgraphWithGlobalSummary`；`budget?`: `{maxEdges?, maxDepth?, maxLeaseSeconds?}`，各自受上限约束 |
| `get_reasoning_session`    | 否     | `sessionId`: ID                                                                                                                                                                                                                                                            |
| `list_reasoning_sessions`  | 否     | `includeFinished?`: boolean，默认 `false`；`limit?`: 正整数 ≤500，默认 `100`                                                                                                                                                                                               |
| `finish_reasoning_session` | 是     | 通用写字段；`goalState`: enum；`reason`: string 1–2000                                                                                                                                                                                                                     |

返回：创建返回 `{session, goalVertex}`；查询返回 `{session}`；列表返回 `{sessions}`；结束返回 `{graphRevision, lastEventSeq, session, abandonedEdgeIds}`。结束调用建议使用终态 `GoalSatisfied`、`GoalConflicted`、`Exhausted`、`BudgetExceeded` 或 `StructurallyInvalid`；当前 schema 虽接受任意 `goalState`，传入 `Exploring`/`CandidateFound`/`Verifying` 不会把会话真正置为终态。

#### 顶点工具

| 工具                  | 变更图 | 输入                                                                                                          |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `add_state_vertex`    | 是     | 通用写字段；`vertexId?`: ID；`label`: string 1–400；`payload?`: object，默认 `{}`；`dedupeKey?`: string 1–400 |
| `add_evidence_vertex` | 是     | 与 `add_state_vertex` 完全相同；服务端将顶点 `kind` 设为 `Evidence`                                           |
| `get_vertex`          | 否     | `sessionId`: ID；`vertexId`: ID                                                                               |

写入顶点返回 `{graphRevision, lastEventSeq, vertex, deduplicated}`。使用相同去重键/内容重新提交时，`deduplicated=true`，当前实现不新增事件，并通过事务的 no-op 分支保持原 `graphRevision`。查询返回 `{vertex, incomingEdgeIds, outgoingEdgeIds}`。

#### 推理边与调度工具

| 工具                       | 变更图 | 输入                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose_inference_edge`   | 是     | 通用写字段；`edgeId?`: ID（仅展开为一条边时可用）；`sourceVertexIds`: 非空 ID 数组；`targetVertexIds`: 非空 ID 数组；`label`: string 1–400；`cost?`: 有限非负数，默认 `1`；`priority?`: 有限数，默认 `0`；`evidenceQuestions?`: 数组，默认 `[]`，元素 `{questionId?, prompt}`（prompt 1–2000）；`dedupeKey?`: string 1–400 |
| `get_inference_edge`       | 否     | `sessionId`: ID；`edgeId`: ID                                                                                                                                                                                                                                                                      |
| `list_candidate_edges`     | 否     | `sessionId`: ID；`strategy?`: enum；`limit?`: 正整数 ≤500，默认 `50`                                                                                                                                                                                                                               |
| `claim_inference_edge`     | 是     | 通用写字段；`edgeId`: ID；`leaseSeconds?`: 正整数 ≤86400，实际不会超过 session budget                                                                                                                                                                                                              |
| `claim_inference_edges`    | 是     | 通用写字段；`maxEdges?`: 正整数 ≤50，默认 `5`；`strategy?`: enum；`leaseSeconds?`: 正整数 ≤86400                                                                                                                                                                                                   |
| `release_inference_edge`   | 是     | 通用写字段；`edgeId`: ID；`leaseId`: ID；`reason?`: string ≤2000                                                                                                                                                                                                                                   |
| `answer_evidence_question` | 是     | 通用写字段；`edgeId`: ID；`questionId`: ID；`leaseId`: ID；`answer`: string 1–4000                                                                                                                                                                                                                 |
| `complete_inference_edge`  | 是     | 通用写字段；`edgeId`: ID；`leaseId`: ID；`inputContextHash`: 小写 64 位十六进制 SHA-256；`conclusion`: string 1–4000；`goalState?`: enum                                                                                                                                                           |
| `block_inference_edge`     | 是     | 通用写字段；`edgeId`: ID；`leaseId?`: ID（边为 `Leased` 时必需）；`reason`: string 1–2000                                                                                                                                                                                                          |

返回：

- `propose_inference_edge`：`{graphRevision, lastEventSeq, edge, edges, deduplicated}`；`edges` 是按输入来源 × 目标顺序的全部独立边，`edge` 是第一条，供单边客户端兼容使用。同一目标的一次多来源提议共享一个 `formulaId`，表示组内合取。
- `get_inference_edge`：`{edge}`。
- `list_candidate_edges`：`{edges, graphRevision}`。
- 单边 claim：`{graphRevision, lastEventSeq, leaseId, edge, context}`。
- 批量 claim：`{graphRevision, lastEventSeq, claims:[{leaseId, edge, context}]}`。
- release/answer/block：`{graphRevision, lastEventSeq, edge}`。
- complete：`{graphRevision, lastEventSeq, edge, session}`。

`propose_inference_edge` 会逐条边去重；只有本次展开出的全部关系都已存在时才返回 `deduplicated=true`，此时不新增事件并保持原 revision。部分命中时会只创建缺少的独立边，并返回全部 `edges`。

claim 会在同一事务内回收已经过期的租约，再按指定边或策略重新领取；因此一次调用也可能引起 `EdgeLeaseExpired` 事件。一个边同时最多有一个有效租约。

#### 上下文工具

| 工具                     | 变更图 | 输入                                                                                     | 返回                                                                                 |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `get_context_for_vertex` | 否     | `sessionId`、`vertexId`；`policy?`；`expansionHandleId?`                                 | `{context: VertexExpansionContext}`                                                  |
| `get_reasoning_text_for_vertex` | 否 | `sessionId`、`vertexId`；`policy?`；`expansionHandleId?` | `{context, reasoningText, mermaid}` |
| `get_context_for_edge`   | 否     | `sessionId`、`edgeId`；`policy?`；`expansionHandleId?`                                   | `{context: EdgeExecutionContext}`                                                    |
| `get_reasoning_context`  | 否     | `sessionId`；`afterEventSeq?` 非负整数，默认 `0`；`eventLimit?` 正整数 ≤1000，默认 `200` | `{snapshot, frontierEdgeIds, edgeCountByState, events, nextEventSeq, hasMoreEvents}` |

`get_reasoning_text_for_vertex` 使用与 `get_context_for_vertex` 相同的依赖投影，返回包含 Mermaid 代码块的 `reasoningText` 和可单独渲染的原始 `mermaid`。文本会写出当前顶点的合取公式、完成进度及多个公式组间的析取关系；Mermaid 把公式摘要写在当前顶点标签中，仍只画带 `En` 标签的直接箭头，不会生成不存在的中间公式节点或推导连线。`get_context_for_edge` 的 `context.contextHash` 是执行视角的哈希；claim 返回的 context 会被归档，complete 必须提交 claim 返回的那一个 hash。`get_reasoning_context` 的增量游标是 `eventSeq`，不要用 `graphRevision` 分页。

### 8.2 顶点/边返回对象的关键字段

`Vertex`：`vertexId`、`referenceId`（`Vn`）、`kind`、`label`、`payload`、`dedupeKey?`、`createdByAgentId`、`createdAt`、`createdAtRevision`。

`InferenceEdge`：`edgeId`、`referenceId`（`En`）、`formulaId`（同一顶点公式的独立边分组）、`sourceVertexIds`（恰好一个顶点）、`targetVertexIds`（恰好一个顶点）、`label`、`state`、`cost`、`priority`、`evidenceQuestions`、`conclusion?`、`blockedReason?`、`lease?`、`dedupeKey?`、`proposedByAgentId`、`createdAt`、`createdAtRevision`、`updatedAtRevision`。

`EdgeExecutionContext` 还包含 `goalVertex`、`sourceVertices`、`targetVertices`、祖先顶点/边、证据问题、可选全局摘要、扩展句柄、遗漏 ID 和 `contextHash`。`VertexExpansionContext` 对应包含当前顶点及其必要祖先子图。

## 9. 推荐的完整调用流程

下面的流程适合一个或多个 Agent 协作。每一步都从上一步响应中读取 revision 和 ID：

1. `create_reasoning_session`，保存 `session.sessionId`、`session.graphRevision`、`goalVertex.vertexId`。
2. 用当前 revision 调用 `add_state_vertex` / `add_evidence_vertex`，保存返回顶点 ID 和新 revision。
3. 以一个或多个来源和目标顶点 ID 调用 `propose_inference_edge`；数组会展开为独立边，需要取证时每条边都会获得自己的 `evidenceQuestions` 记录。
4. 调用 `list_candidate_edges` 观察前沿，或直接 `claim_inference_edge` / `claim_inference_edges`。
5. 保存 claim 返回的 `leaseId`、`lease.expiresAt` 和 `context.contextHash`，在租约有效期内完成工作。
6. 对每个未回答问题调用 `answer_evidence_question`。回答问题不改变 claim-time hash，仍使用原 hash 完成。
7. 调用 `complete_inference_edge`，提交最新可用 `baseGraphRevision`、原始 `leaseId`、原始 `inputContextHash` 和结论。服务端会执行证据问题完整性检查及环检测。
8. 用 `get_reasoning_context({afterEventSeq: 上次游标})` 增量同步快照和事件；返回 `hasMoreEvents=true` 时继续用 `nextEventSeq` 拉取。
9. 无法完成时，在持有有效租约的情况下 `release_inference_edge` 让其他 Agent 重试，或 `block_inference_edge` 记录阻塞原因。确认任务终态后调用 `finish_reasoning_session`。

### 9.1 多 Agent 并发规则

- 每个写请求都要使用该会话当前 revision；收到 `RevisionConflict` 后先读 `get_reasoning_context` 或 `get_reasoning_session`，再以服务端 `actual` revision 重试。
- 不同边可以并行 claim；同一边只有一个有效 lease。
- 其他 Agent 推进无关边不会使本边 claim-time hash 失效；本边材料改变、租约过期或 lease/agent 不匹配会拒绝完成。
- 不要在客户端自行把过期 `Leased` 状态当成可完成；重新 claim，让服务端在事务中回收并发放新 lease。

## 10. 错误码与处理建议

所有业务错误都遵循：

```json
{ "code": "...", "message": "...", "detail": {} }
```

| 错误码                | 常见原因                                       | 客户端动作                                      |
| --------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `InvalidInput`        | 参数不合法、未知工具、未回答问题、非法状态转换 | 修正参数；查看 `detail.issues` 或 `questionIds` |
| `SessionNotFound`     | session 不存在或已被清理                       | 检查 ID；必要时重新创建/连接                    |
| `SessionFinished`     | 会话已进入终态                                 | 只读查询或创建新会话                            |
| `VertexNotFound`      | 顶点 ID 不属于该会话                           | 重新读取快照和 ID                               |
| `EdgeNotFound`        | 边 ID 不存在                                   | 重新读取前沿                                    |
| `QuestionNotFound`    | 问题不在该边                                   | 重新读取 edge 的 `evidenceQuestions`            |
| `RevisionConflict`    | `baseGraphRevision` 过期                       | 读取 `detail.actual`，更新 revision 后重试      |
| `ContextStale`        | 提交的 hash 与 claim-time hash 不同            | 重新 claim/读取该边上下文，不要伪造 hash        |
| `CycleDetected`       | 完成会产生已完成子图环                         | 调整图或阻塞该边                                |
| `EdgeNotClaimable`    | 边不是 Candidate，或被其他有效 lease 持有      | 重新列前沿并稍后重试                            |
| `LeaseNotHeld`        | lease ID 或 agent ID 不匹配，或边已释放        | 使用当前持有者的 lease，或重新 claim            |
| `LeaseExpired`        | lease 已超过 `expiresAt`                       | 重新 claim                                      |
| `BudgetExceeded`      | 达到 `maxEdges` 等预算                         | 调整会话预算或结束会话                          |
| `StructurallyInvalid` | 数据结构损坏或上下文无法投影                   | 停止调度，检查数据库和日志                      |
| `DuplicateEntity`     | 显式 ID 已存在                                 | 使用新 ID 或使用 dedupe 语义                    |
| `StorageFailure`      | SQLite/审计/持久化异常                         | 检查磁盘、权限、日志，避免盲目重放写请求        |

MCP 层通常仍返回 JSON-RPC 成功 envelope，只在工具结果中设置 `isError=true`。直接 JSON bridge 则按状态码返回：`InvalidInput=400`，资源不存在=404，并发/租约/环/重复=409，其余=500。

## 11. 监控与排障

```bash
# 查看服务健康状态
curl http://127.0.0.1:8791/health

# 查看实际暴露的工具
curl http://127.0.0.1:8791/api/tools

# 只看 MCP 或 Core 日志（JSON 日志）
tail -f data/logs/reasoner-server.log | jq 'select(.component == "mcp" or .component == "core")'

# 只看稳定错误码
tail -f data/logs/reasoner-server.log | jq 'select(.errorCode)'
```

常见现象：

- `Mcp-Session-Id header is required`：第一次请求不是 `initialize`，或客户端丢失了初始化响应头。
- `Session not found`：服务重启后继续使用旧 session id；重新连接即可，图数据不会因重连而丢失。
- `RevisionConflict`：并发 Agent 使用了旧 revision；读取当前快照后重试。
- `LeaseExpired`：处理时间超过租约；重新 claim，并适当提高会话 `maxLeaseSeconds`。
- `ContextStale`：不要用刚重新计算但未归档的猜测值；完成时必须提交 claim 返回的 `context.contextHash`。
- `CycleDetected`：服务端拒绝写入，不需要回滚客户端；调整前提/目标关系后重新提出边。

## 12. 版本与扩展

工具列表的单一事实来源是 `packages/reasoner-mcp/src/reasoner-tool-controller.ts`，输入/输出 schema 在 `packages/reasoner-schema/src/mcp.ts`。接入方应在连接后执行 `tools/list`，不要假设未来版本仍只有这 20 个工具。

如果需要在另一个 Node 进程中嵌入 MCP server，可依赖 `@reasoner/mcp` 的 `createReasonerMcpServer(service)`；该函数只创建 MCP server 和 controller，不创建存储或 HTTP listener。生产接入仍建议使用 `@reasoner/server`，让数据目录、生命周期和 session transport 由统一应用管理。

兼容性验收建议至少覆盖：

1. `initialize`、`notifications/initialized`、`tools/list` 成功。
2. 创建会话、提出边、claim、回答问题、complete 的完整链路。
3. 过期 lease、旧 revision、错误 hash、成环提交都能得到对应稳定错误码。
4. 关闭并重启 server 后，重新连接仍能读取原 session 和事件游标。

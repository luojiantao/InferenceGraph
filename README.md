# InferenceGraph

InferenceGraph 是一个本地优先的证据图推理协调服务。它把多个 Agent 提交的目标、状态、证据和推理关系保存为有向超图，并负责并发协调、上下文一致性、结构校验和审计追踪。

当前仓库版本为 `0.1.0`。本文档只描述源码中已经实现的行为；MCP 参数的完整 schema 和逐工具示例见 [MCP 接入与使用指南](Doc/MCP接入与使用指南.md)。反向定位问题并创建候选前提与推理边的操作流程见 [反向推理基本步骤](Doc/反向推理基本步骤.md)。

## 项目边界

InferenceGraph 负责记录和调度推理过程，不负责：

- 生成领域事实、替 Agent 调用 LLM 或自行发明结论；
- 替调用方判断证据是否真实；
- 提供用户认证、权限管理或公网安全边界。

调用方必须提交标签、载荷、问题答案和最终结论。Core 只校验图结构、会话状态、租约、revision 和上下文哈希。

## 当前实现

| 组件          | 实现                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| 运行时        | Node.js `>=24.0.0`（当前开发环境为 `24.14.0`）                             |
| 包管理        | pnpm `11.20.0`，pnpm workspace                                             |
| 服务端        | Fastify `5.11.2`                                                           |
| MCP           | MCP SDK `1.30.0`，Streamable HTTP + JSON 响应                              |
| 存储          | Node 内置 `node:sqlite`、SQLite WAL、JSONL 审计旁路                        |
| 类型与校验    | TypeScript `5.9.3`、Zod `3.25.76`                                          |
| Web UI        | React `19.2.8`、Vite `8.2.1`、Cytoscape `3.34.0`、TanStack Query `5.101.4` |
| 测试          | Vitest `3.2.4`、Playwright `1.57.0`                                        |
| MCP HTTP 地址 | `http://127.0.0.1:8791/mcp`                                                |
| Web 开发地址  | `http://127.0.0.1:5174`                                                    |
| 工具数量      | 26 个（以 `tools/list` 为准）                                              |
| 认证          | 当前没有认证层，默认只绑定回环地址                                         |
| stdio         | 当前没有 stdio server 入口                                                 |

## 核心能力

- **独立有向推理边**：每条持久化边恰好连接一个来源顶点和一个目标顶点，并独立拥有 `En`、状态、证据、租约和完成记录；批量输入会展开为多条边，并保留顶点公式的合取语义。
- **确定性前沿**：支持 `DFS`、`BFS` 和 `Priority` 三种策略，平局时按 ID 稳定排序，便于复现和审计。
- **乐观并发**：每个写操作携带 `baseGraphRevision`，SQLite 事务在写锁内完成 revision 校验、业务规划和提交。
- **租约协调**：一条边同一时间最多一个有效租约；过期租约会在后续领取事务中回收。
- **上下文一致性**：领取边时保存执行上下文哈希，完成时必须提交领取时的 `inputContextHash`。
- **结构保护**：完成推理边时拒绝会形成环的结果；Core 另提供恢复期结构校验方法。
- **事件审计**：每个会话有严格递增的 `eventSeq`，多个事件可以共享同一个 `graphRevision`。
- **可视化与手动校正**：Web UI 展示图、候选前沿、边/顶点检查器、上下文投影、并行租约和事件时间线，并可通过版本校验编辑顶点与推理边的可编辑字段。

## 目录结构

```text
InferenceGraph/
├── apps/
│   ├── reasoner-server/       # Fastify HTTP 服务、MCP transport、JSON bridge
│   └── reasoner-web/          # React + Cytoscape 可视化界面
├── packages/
│   ├── reasoner-schema/       # Zod schema、ID、错误和领域类型
│   ├── reasoner-core/         # 推理服务、图算法、前沿和上下文投影
│   ├── reasoner-storage/      # SQLite repository、迁移和 JSONL 审计
│   ├── reasoner-mcp/          # 26 个 MCP 工具及统一 controller
│   ├── reasoner-logging/      # Pino 文件日志、轮转和脱敏
│   └── reasoner-test-agent/   # 不访问网络的 BD1 fixture 回放 CLI
├── tests/
│   ├── contract/              # MCP 工具表面、schema 和端到端工具流
│   └── integration/           # 存储、并发、恢复和 BD1 回放
├── Doc/
│   └── MCP接入与使用指南.md   # MCP transport、客户端和参数详解
└── data/                      # 本地运行时生成，已被 .gitignore 忽略
```

运行链路如下：

```text
MCP Host / Web UI
        │ Streamable HTTP 或 /api/tools JSON bridge
        ▼
Fastify reasoner-server
        ▼
ReasonerToolController
        ▼
ReasonerService（图规则、revision、租约、上下文）
        ▼
SQLite + JSONL audit
```

## 快速开始

### 1. 安装和构建

```bash
corepack enable
pnpm install
pnpm build
```

`pnpm build` 会按 workspace 依赖顺序构建所有 package、服务端和 Web UI。Node.js 必须为 24 或更高版本；项目通过 `packageManager` 字段锁定 pnpm `11.20.0`。

### 2. 启动 Reasoner Server

在仓库根目录执行，默认数据和日志会落在根目录的 `data/`：

```bash
node apps/reasoner-server/dist/main.js
```

也可以使用 workspace 脚本：

```bash
pnpm server:dev      # 监听已构建的 dist/main.js
pnpm --filter @reasoner/server start
```

`server:dev` 监听的是编译产物，不会自动把 TypeScript 编译成 JavaScript；修改源码后请重新运行 `pnpm build`。相对路径（例如 `./data`）始终相对于服务进程的当前工作目录。

启动后检查：

```bash
curl http://127.0.0.1:8791/health
```

预期响应：

```json
{ "status": "ok", "tools": 26 }
```

### 3. 启动 Web UI

另开一个终端：

```bash
pnpm web:dev
```

访问 <http://127.0.0.1:5174>。Vite 开发服务器只绑定回环地址，并把 `/api`、`/mcp` 和 `/health` 代理到 `http://127.0.0.1:8791`。前端实际配置端口是 `5174`，不是旧 README 中的 `5173`。

如果后端使用了其他端口，可在启动 Web 前设置：

```bash
# Bash
REASONER_SERVER_PORT=8891 pnpm web:dev

# PowerShell
$env:REASONER_SERVER_PORT = '8891'
pnpm web:dev
```

### 4. 生产式静态部署（可选）

先构建前端，再让 Fastify 直接提供静态文件：

```bash
pnpm --filter @reasoner/web build
REASONER_WEB_ROOT=/absolute/path/to/apps/reasoner-web/dist \
  node apps/reasoner-server/dist/main.js
```

PowerShell 示例：

```powershell
pnpm --filter @reasoner/web build
$env:REASONER_WEB_ROOT = (Resolve-Path .\apps\reasoner-web\dist).Path
node .\apps\reasoner-server\dist\main.js
```

设置成功后，Web 页面和 API 共用 `REASONER_PORT`；未设置或路径不存在时，服务仍会提供 API，但只记录警告，不提供静态页面。

## MCP 接入

### 连接信息

| 项目        | 值                                                               |
| ----------- | ---------------------------------------------------------------- |
| URL         | `http://127.0.0.1:8791/mcp`                                      |
| Transport   | Streamable HTTP                                                  |
| 响应模式    | JSON（同时兼容 `application/json, text/event-stream` 的 Accept） |
| 服务名/版本 | `inference-graph-reasoner` / `0.1.0`                             |
| 认证        | 无                                                               |
| stdio       | 不提供                                                           |

不要把根地址 `/`、`/health` 或 `/api/tools/:tool` 当作 MCP 地址。`/api/tools/:tool` 是给 Web UI 使用的直接 JSON bridge，不是 MCP transport。

### Codex 配置示例

当前仓库的 `.codex/config.toml` 可直接使用：

```toml
[mcp_servers.inference_graph]
url = "http://127.0.0.1:8791/mcp"
enabled = true
default_tools_approval_mode = "auto"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

支持 URL 型 MCP 配置的其他 Host 可使用等价 JSON：

```json
{
  "mcpServers": {
    "inference-graph": {
      "url": "http://127.0.0.1:8791/mcp"
    }
  }
}
```

只支持 stdio 配置的 Host 需要外部的 HTTP-to-stdio 适配器（例如 `mcp-remote`）；该适配器不属于本仓库，且必须确认它支持 Streamable HTTP。

### 会话生命周期

1. 客户端向 `/mcp` 发送 `initialize`，响应头会返回 `Mcp-Session-Id`。
2. 保存该 header，并发送 `notifications/initialized`。
3. 后续 `tools/list` 和 `tools/call` 请求都带上同一个 `Mcp-Session-Id`；建议同时带服务端协商出的 `Mcp-Protocol-Version`。
4. 结束时发送带 session header 的 `DELETE /mcp`。

没有 session header 的非初始化请求返回 HTTP `400`；未知 session 返回 HTTP `404`。服务重启后旧 session 不再有效，客户端必须重新初始化。

最小初始化请求：

```http
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
```

完整的手工握手、Node SDK 客户端、错误处理和参数表见 [MCP 接入与使用指南](Doc/MCP接入与使用指南.md)。

## HTTP 接口

| 路径               | 方法                    | 用途                                                |
| ------------------ | ----------------------- | --------------------------------------------------- |
| `/health`          | `GET`                   | 返回服务状态和工具数量                              |
| `/api/tools`       | `GET`                   | 返回工具名称、描述和是否修改图状态                  |
| `/api/tools/:tool` | `POST`                  | 直接调用同一个 controller，供 Web UI 或诊断脚本使用 |
| `/mcp`             | `POST`、`GET`、`DELETE` | MCP Streamable HTTP JSON-RPC 会话和工具调用         |

JSON bridge 示例：

```http
POST /api/tools/list_reasoning_sessions
Content-Type: application/json

{"limit":20,"includeFinished":false}
```

bridge 成功时直接返回工具值；失败时返回 `{ "error": { "code", "message", "detail" } }`，并映射为 `400`（输入错误）、`404`（资源不存在）、`409`（并发/租约/环/重复）或 `500`。MCP transport 通常仍返回 JSON-RPC 成功 envelope，但工具结果会设置 `isError: true`，客户端应读取结构化错误码。

## 推理模型和工作流

### 图模型

- 顶点类型：`Goal`、`State`、`Evidence`。
- 推理边是有向、带标签的独立二元关系。持久化后每条边的 `sourceVertexIds` 和 `targetVertexIds` 都各有一个顶点；`propose_inference_edge` 的数组参数会按来源 × 目标展开为多条独立边。
- 一次多来源提议的直接边属于同一个顶点公式组：组内是合取（全部边完成才推出目标），同一目标的不同公式组是析取（任一完整公式组即可推出目标）。公式组不是顶点，也不会在画布中生成中间节点。
- 边状态：`Candidate`、`Leased`、`Completed`、`Blocked`、`Abandoned`、`Invalid`。
- 会话目标状态：`Exploring`、`CandidateFound`、`Verifying`、`GoalSatisfied`、`GoalConflicted`、`Exhausted`、`BudgetExceeded`、`StructurallyInvalid`。

### 推荐调用顺序

```text
create_reasoning_session
        ↓
add_state_vertex / add_evidence_vertex
        ↓
propose_inference_edge
        ↓
list_candidate_edges 或 claim_inference_edges
        ↓
answer_evidence_question（如有问题）
        ↓
complete_inference_edge / block_inference_edge / release_inference_edge
        ↓
get_reasoning_context / get_context_for_vertex / get_downstream_context_for_vertex / get_reasoning_text_for_vertex / get_context_for_edge
        ↓
finish_reasoning_session（需要显式结束时）
```

除 `create_reasoning_session` 外，写操作都携带 `sessionId`、`agentId` 和调用方观察到的 `baseGraphRevision`。`delete_reasoning_session` 还必须发送 `confirm: true`，并在 Web UI 中输入完整会话 ID 确认；它会级联删除 SQLite 中的图数据，但 JSONL 审计文件仍按追加式策略保留。同一事务内的所有事件共享一次 revision，但每个事件拥有不同且连续的 `eventSeq`；增量读取必须使用 `afterEventSeq`，不能把 `graphRevision` 当事件游标。

领取边时生成租约和执行上下文。完成边必须使用领取返回的 `inputContextHash`，并且所有证据问题都已回答；否则返回 `ContextStale` 或相应的业务错误。重复提交命中 dedupe 时是幂等结果，不会额外消耗 revision。

## MCP 工具

工具的输入 schema 位于 `packages/reasoner-schema/src/mcp.ts`，注册和业务映射位于 `packages/reasoner-mcp/src/reasoner-tool-controller.ts`。客户端连接后应执行 `tools/list`，不要硬编码未来版本的工具数量。

### 会话内实体索引

`V1`、`V2`… 和 `E1`、`E2`… 是会话范围内的正式实体引用，不是只供 Web 显示的文案。它们在顶点或边创建时于同一写事务内分配并持久化到 `referenceId`，不会因读取顺序、筛选范围或前端重绘而重新计算；一个 `En` 始终只对应一条直接箭头，不会生成中间节点或与其他关系合并。

例如一次调用传入 `sourceVertexIds: [V1, V3, V4]`、`targetVertexIds: [V9]` 时，会产生：`V1 -> V9 = E1`、`V3 -> V9 = E2`、`V4 -> V9 = E3`。三条线各自独立，但 `V9` 的公式是 `E1 ∧ E2 ∧ E3: V1 ∧ V3 ∧ V4 -> V9`，所以三条边都完成后才推出 `V9`。若另一次调用再为 `V9` 创建公式组，则完整的任一公式组即可推出 `V9`。响应中的 `edges` 按该顺序返回全部边；为兼容单边调用，`edge` 仍是其中第一条。批量展开为多条边时不能同时指定单个内部 `edgeId`。

所有引用既有顶点或边的 MCP 参数都同时接受内部 ID 和 `Vn`/`En`：例如 `get_vertex`、`update_vertex`、`get_context_for_vertex`、`get_downstream_context_for_vertex`、`get_reasoning_text_for_vertex`、`propose_inference_edge` 的前提/结论数组，以及 `get_inference_edge`、`update_inference_edge`、领取、释放、完成、阻塞和 `get_context_for_edge`。服务会在调用业务逻辑前解析为内部 ID。新建顶点或边时可选的 `vertexId` / `edgeId` 仍表示调用方指定的内部 ID，但不得使用保留的 `Vn` / `En` 格式，以免与正式引用冲突。

### 会话和顶点

| 工具                                     | 作用                                                           | 修改图 |
| ---------------------------------------- | -------------------------------------------------------------- | ------ |
| `create_reasoning_session`               | 创建会话和 Goal 顶点；可同时设置别名和标签                     | 是     |
| `get_reasoning_session`                  | 读取会话状态、别名、标签、策略、预算和 revision                | 否     |
| `update_reasoning_session_metadata`      | 替换会话别名和完整标签列表，不改变 `Vn` / `En`                 | 是     |
| `delete_reasoning_session`               | 经版本校验和显式确认后删除整个 SQLite 会话图                   | 是     |
| `increase_reasoning_session_edge_budget` | 提高活动会话的物理边预算 `maxEdges`                            | 是     |
| `list_reasoning_sessions`                | 按最近更新时间列出会话                                         | 否     |
| `finish_reasoning_session`               | 以显式目标状态结束会话，并将 Candidate/Leased 边置为 Abandoned | 是     |
| `add_state_vertex`                       | 添加 State 顶点                                                | 是     |
| `add_evidence_vertex`                    | 添加 Evidence 顶点                                             | 是     |
| `get_vertex`                             | 读取顶点及其入/出边 ID                                         | 否     |
| `update_vertex`                          | 更新顶点标签和 JSON 载荷；不改变 `Vn` 或类型                   | 是     |

### 推理边和租约

| 工具                       | 作用                               | 修改图 |
| -------------------------- | ---------------------------------- | ------ |
| `propose_inference_edge`   | 提出独立候选推理边及证据问题       | 是     |
| `get_inference_edge`       | 读取边、状态、租约和问题           | 否     |
| `update_inference_edge`    | 更新描述、成本、优先级和候选边问题 | 是     |
| `list_candidate_edges`     | 按 DFS/BFS/Priority 返回候选前沿   | 否     |
| `claim_inference_edge`     | 领取一条边并获得执行上下文         | 是     |
| `claim_inference_edges`    | 按策略批量领取多条边               | 是     |
| `release_inference_edge`   | 释放租约，使边回到候选前沿         | 是     |
| `answer_evidence_question` | 记录租约持有者对问题的回答         | 是     |
| `complete_inference_edge`  | 使用上下文哈希完成边并检查环       | 是     |
| `block_inference_edge`     | 以原因阻塞一条边                   | 是     |

### 上下文和审计

| 工具                                | 作用                                         | 修改图 |
| ----------------------------------- | -------------------------------------------- | ------ |
| `get_context_for_vertex`            | 获取顶点的依赖投影、证据摘要和扩展句柄       | 否     |
| `get_downstream_context_for_vertex` | 获取直接下游关系和到 Goal 的最短路径摘要     | 否     |
| `get_reasoning_text_for_vertex`     | 将顶点依赖投影转写为推理文本和 Mermaid 图    | 否     |
| `get_context_for_edge`              | 获取执行边所需的前提、结论、祖先和上下文哈希 | 否     |
| `get_reasoning_context`             | 获取会话快照、前沿、状态计数和分页事件       | 否     |

`get_reasoning_text_for_vertex` 接受与 `get_context_for_vertex` 相同的 `sessionId`、`vertexId`、`policy` 和 `expansionHandleId`。它返回原始 `context`、可直接展示的 Markdown `reasoningText`（其中包含 Mermaid 代码块）和可单独渲染的原始 `mermaid`。文本会先列出当前顶点的公式组以及每组完成进度；Mermaid 只绘制该顶点的依赖投影，不会额外注入无关的会话 Goal，并保留 Candidate、Leased、Completed 与 Blocked 的上游关系。当前顶点的公式摘要写在该顶点标签中，每条直接箭头则显示 `En · 边描述`，不生成中间公式节点。

```json
{
  "sessionId": "sched-replay-r2-car1-1786326968949",
  "vertexId": "V9",
  "policy": "DependencySubgraphWithGlobalSummary"
}
```

## Web UI

Web UI 不直接访问 SQLite，所有写入都通过与 MCP 共用的 JSON bridge，并使用当前 `graphRevision` 做并发校验。当前界面提供：

- 会话选择、目标状态、当前 `graphRevision` 和事件游标；
- Cytoscape 图画布，按边状态显示候选、租约、完成、阻塞等关系；
- 候选前沿列表，保持 Core 返回的确定性顺序；
- 边检查器、顶点检查器和依赖范围切换；
- 顶点标签和 JSON 载荷编辑；推理边描述、成本、优先级和 Candidate 取证问题编辑；
- 与 MCP 共用的持久化 `V1`、`V2`… 顶点索引和 `E1`、`E2`… 推理边索引；画布把每个 `E` 直接标在它自己的箭头上；
- 顶点检查器展示 `E1 ∧ E2 ... -> Vn` 公式、完成进度和组间的析取关系；
- 上下文投影、遗漏实体和扩展句柄查看；
- 按 Agent 聚合的并行租约面板；
- 状态视图和完整审计视图，以及按 `eventSeq` 增量合并的事件时间线。

图快照默认每 `1.5s` 轮询一次，会话列表每 `5s` 刷新一次。页面保留最后一次有效快照，并把连续失败分为“重连中”和“已断开”。

## 配置

服务配置从环境变量读取。所有相对路径均相对于服务进程的当前工作目录。

### 服务端

| 变量                    | 默认值      | 说明                                               |
| ----------------------- | ----------- | -------------------------------------------------- |
| `REASONER_HOST`         | `127.0.0.1` | Fastify 监听地址；改为非回环地址会暴露未认证写接口 |
| `REASONER_PORT`         | `8791`      | HTTP 端口                                          |
| `REASONER_DATA_DIR`     | `./data`    | SQLite、审计目录的根路径                           |
| `REASONER_WEB_ROOT`     | 未设置      | 已构建 Web 静态文件目录；不存在时只提供 API        |
| `REASONER_ENABLE_AUDIT` | `true`      | 是否写入 JSONL 审计旁路                            |

### 日志

| 变量                       | 默认值                | 说明                                                           |
| -------------------------- | --------------------- | -------------------------------------------------------------- |
| `REASONER_LOG_LEVEL`       | `info`                | `trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent` |
| `REASONER_LOG_DIR`         | `./data/logs`         | 轮转日志目录                                                   |
| `REASONER_LOG_FILE`        | `reasoner-server.log` | 日志文件名；显式设置会覆盖服务名默认值                         |
| `REASONER_LOG_ROTATE_SIZE` | `20m`                 | 单文件轮转大小                                                 |
| `REASONER_LOG_RETAIN`      | `20`                  | 保留的轮转文件数量                                             |
| `REASONER_LOG_CONSOLE`     | `true`                | 是否同时输出到 stdout                                          |
| `REASONER_LOG_PRETTY`      | `false`               | 是否使用可读的 console 格式                                    |

日志使用 Pino/pino-roll，默认会脱敏 `payload.token`、`payload.secret`、`payload.password`、`payload.apiKey` 以及 authorization/cookie 请求头。审计 JSONL 是 SQLite 提交后的旁路记录；审计写入失败不会回滚已经提交的数据库事务。

默认目录布局：

```text
data/
├── reasoner.db
├── audit/<sessionId>.jsonl
└── logs/reasoner-server.log
```

## 开发和验证

```bash
pnpm typecheck       # TypeScript project references + Web 类型检查
pnpm lint            # ESLint
pnpm format:check    # Prettier，只检查不改写
pnpm test            # Vitest：单元、契约和集成测试
pnpm build           # 构建所有 workspace 包和应用
pnpm replay:bd1      # 使用内置 fixture 在内存中回放 DFS/BFS
```

当前测试配置覆盖 6 个测试文件；运行 `pnpm test` 可验证图语义、MCP 工具契约、SQLite revision/CAS、租约并发、重启恢复和 BD1 回放。Playwright 配置已预留 `pnpm test:e2e`，但当前仓库没有 `tests/e2e` 测试文件；它使用 Web preview 默认端口 `4173`，与开发端口 `5174` 不同。

新增 MCP 工具时，保持以下顺序：

1. 在 `packages/reasoner-schema/src/mcp.ts` 增加输入/输出 schema。
2. 在 `packages/reasoner-core/src/reasoner-service.ts` 实现业务逻辑。
3. 在 `packages/reasoner-mcp/src/reasoner-tool-controller.ts` 注册并映射 controller。
4. 在 `tests/contract/mcp-tools.test.ts` 增加工具表面和行为契约。

## 故障排查

### MCP 客户端连接失败

1. 先确认 `GET http://127.0.0.1:8791/health` 返回 200。
2. 客户端 URL 必须是 `http://127.0.0.1:8791/mcp`，不能省略 `/mcp`。
3. 选择 Streamable HTTP；本项目没有 stdio 入口。
4. 初始化响应中的 `Mcp-Session-Id` 必须保存并用于后续请求。
5. 服务重启后旧 session 会失效，重新加载 MCP Host 或重新连接即可。
6. 若修改了 `REASONER_PORT`，同时更新客户端 URL；Web UI 还要更新 `REASONER_SERVER_PORT`。

### Web 页面打不开或没有数据

- 开发页面地址是 `http://127.0.0.1:5174`，不是 `5173`。
- 确认后端 `8791` 正在运行；Vite 代理依赖该端口。
- Web UI 可新建会话、编辑会话别名/标签、顶点和边的可编辑字段，并在确认后删除整个 SQLite 会话图；MCP 仍可用于完整的推理建模和执行。
- 查看浏览器网络面板和 `data/logs/reasoner-server.log` 中的结构化错误码。

### 服务启动失败

- 先执行 `pnpm build`，确认 `apps/reasoner-server/dist/main.js` 存在。
- 检查 `REASONER_PORT` 是否被其他进程占用。
- 检查 `REASONER_DATA_DIR` 和 `REASONER_LOG_DIR` 是否可写。
- Node 24 可能输出 `node:sqlite` experimental warning；这是运行时提示，不代表启动失败。

## 当前限制和安全边界

- 服务没有认证、授权和 CORS 安全层，默认绑定 `127.0.0.1`。如需远程访问，应在可信网络和反向代理认证后使用，不要直接暴露公网。
- MCP 仅支持 Streamable HTTP；需要 stdio 的 Host 必须自行部署并审查适配器。
- `ReasonerService.validateRecoveredSessions()` 已实现恢复结构检查，但当前 `apps/reasoner-server/src/main.ts` 的启动流程不会自动调用它。依赖启动期恢复校验的部署需要在装配层显式接入并验收。
- 图载荷、证据问题和结论都由外部 Agent 提交；系统不会替调用方生成事实或答案。

## 参考资料

- [MCP 接入与使用指南](Doc/MCP接入与使用指南.md)：Streamable HTTP 握手、客户端示例、错误处理和完整参数表。
- [本地推理实现计划](evidence-graph-local-reasoning-implementation-plan.md)：设计背景和验收记录。
- Schema 单一事实来源：`packages/reasoner-schema/src/`。
- MCP 工具单一事实来源：`packages/reasoner-mcp/src/reasoner-tool-controller.ts`。

# InferenceGraph — Evidence-based Reasoning System

超图证据推理引擎，支持多智能体协作的结构化推理与证据追踪。

## 概述

InferenceGraph 是一个基于证据图的推理系统，允许多个 AI 智能体协同构建、验证和完成复杂的推理任务。系统通过 **超图结构** 表达多前提推理，通过 **租约机制** 协调并发工作，通过 **上下文投影** 保证推理的输入一致性。

### 核心特性

- **超图推理** — 支持 AND/OR 双重语义，原生表达多前提推理
- **乐观并发** — 基于 `baseGraphRevision` 的 CAS 机制，无锁并发
- **租约协调** — 自动过期回收 + 上下文哈希验证，防止脏读
- **完整性保护** — 启动时自动检测结构违例，DAG 约束 + 强连通分量检测
- **文件日志** — Pino + 自动轮转，支持分组件诊断（storage/core/mcp/server）
- **MCP 协议** — 19 个工具暴露完整推理面，支持 HTTP 和 Streamable HTTP 传输
- **前端可视化** — React + Cytoscape 实时渲染超图，拓扑变更时才重排

## 系统架构

```
InferenceGraph/
├── packages/
│   ├── reasoner-schema/      # Zod 类型定义与验证
│   ├── reasoner-core/         # 图算法 + 业务逻辑（AND/OR 语义）
│   ├── reasoner-storage/      # SQLite 持久化 + JSONL 审计
│   ├── reasoner-mcp/          # MCP 工具控制器
│   ├── reasoner-logging/      # Pino 文件日志 + 轮转（新增）
│   └── reasoner-test-agent/   # BD1 回放 Agent
├── apps/
│   ├── reasoner-server/       # Fastify HTTP + MCP 服务端
│   └── reasoner-web/          # React 可视化前端
└── tests/
    ├── integration/           # 存储保证 + 恢复测试
    └── contract/              # MCP 工具契约测试
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js 24.14.0（内置 SQLite） |
| 包管理 | pnpm 11.20.0（workspace + Corepack） |
| 类型 | TypeScript 5.8 + `exactOptionalPropertyTypes` |
| 存储 | SQLite (`node:sqlite`) + JSONL 审计 |
| 日志 | Pino 10.3.1 + pino-roll 4.0.0（20MB 轮转，保留 20 份）|
| 传输 | Fastify 5.11.2 + MCP SDK 1.30.0 |
| 前端 | React 19 + Cytoscape 3.30 + TanStack Query 6.9 |
| 测试 | Vitest 3.2.4 + Playwright 1.49.0 |

## 快速开始

### 前置要求

- Node.js ≥ 24.14.0
- pnpm 11.20.0（通过 Corepack 自动启用）

### 安装

```bash
# 克隆仓库
git clone <repository-url>
cd InferenceGraph

# 启用 Corepack（首次运行）
corepack enable

# 安装依赖
pnpm install

# 构建所有包
pnpm -r build
```

### 运行服务器

```bash
cd apps/reasoner-server
node dist/main.js
```

服务器默认监听 `http://127.0.0.1:8791`，日志写入 `data/logs/reasoner-server.log`。

### 运行 Web UI

```bash
# 开发模式
cd apps/reasoner-web
pnpm dev

# 生产构建
pnpm build
```

访问 `http://localhost:5173` 查看可视化界面。

## 配置

### 日志配置（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REASONER_LOG_LEVEL` | `info` | 日志级别：`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent` |
| `REASONER_LOG_DIR` | `./data/logs` | 日志文件目录 |
| `REASONER_LOG_FILE` | `reasoner-server.log` | 日志文件名（支持按服务区分）|
| `REASONER_LOG_ROTATE_SIZE` | `20m` | 单文件大小限制 |
| `REASONER_LOG_RETAIN` | `20` | 保留轮转文件数 |
| `REASONER_LOG_CONSOLE` | `true` | 是否镜像到 stdout |
| `REASONER_LOG_PRETTY` | `false` | 是否使用 pretty 格式（开发时可启用）|

示例：

```bash
# 调试模式 + 保留 50 份日志
REASONER_LOG_LEVEL=debug REASONER_LOG_RETAIN=50 node dist/main.js

# 静默模式（仅关键错误）
REASONER_LOG_LEVEL=error node dist/main.js
```

### 服务器配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REASONER_HOST` | `127.0.0.1` | 监听地址（⚠️ 无认证，暴露公网需谨慎）|
| `REASONER_PORT` | `8791` | 监听端口 |
| `REASONER_DATA_DIR` | `./data` | SQLite 和审计文件目录 |
| `REASONER_WEB_ROOT` | - | 静态文件目录（未设置则不提供前端）|
| `REASONER_ENABLE_AUDIT` | `true` | 是否启用 JSONL 审计日志 |

## 核心概念

### 超图推理

InferenceGraph 使用 **超边（hyperedge）** 表达多前提推理：

```typescript
// 单前提推理（普通有向边）
{ sourceVertexIds: ['A'], targetVertexIds: ['B'] }

// 多前提推理（超边）— AND 语义
{ sourceVertexIds: ['A', 'B', 'C'], targetVertexIds: ['D'] }

// 多目标超边（1.0 新增）
{ sourceVertexIds: ['A'], targetVertexIds: ['B', 'C'] }
```

图算法层实现两套独立语义：
- **OR 语义** (`isReachable`) — 拓扑排序、强连通分量检测
- **AND 语义** (`isSupported`) — B-连通性、最小超路径

### 租约机制

智能体必须先 **claim** 边才能填充结论，租约包含：

1. `inputContextHash` — 上下文快照哈希（来源顶点 + 目标顶点 + 标签 + 证据问题**提示**）
2. `expiresAt` — 过期时间（默认 15 分钟）
3. `agentId` — 持有者标识

**complete** 时对比 `inputContextHash`，不匹配则拒绝（`ContextStale`），防止基于过期上下文的推理被接受。

### 事件溯源

每次状态变更生成一个 `GraphEvent`：

```typescript
{
  eventSeq: 42,           // 会话内严格递增
  sessionId: 'session-...',
  graphRevision: 17,      // 同一事务内的事件共享 revision
  kind: 'EdgeCompleted',
  actorAgentId: 'agent-alice',
  occurredAt: '2025-01-12T10:30:00.000Z'
}
```

前端通过 `afterEventSeq` 游标轮询增量事件，无需全量刷新。

## 开发指南

### 运行测试

```bash
# 所有测试（单元 + 集成 + 契约）
pnpm test

# 仅单元测试
pnpm --filter @reasoner/core test

# E2E 测试（需先启动服务器）
pnpm --filter @reasoner/web test:e2e
```

当前测试覆盖：
- ✅ 42 个测试全部通过
- ✅ 19 个 MCP 工具契约验证
- ✅ 存储事务保证（CAS + 单事务 revision）
- ✅ 恢复完整性检测（DAG + 强连通分量）
- ✅ BD1 回放（DFS/BFS 双策略验证）

### 添加新工具

1. 在 `packages/reasoner-schema/src/mcp.ts` 定义输入/输出 schema
2. 在 `packages/reasoner-core/src/reasoner-service.ts` 实现业务逻辑
3. 在 `packages/reasoner-mcp/src/reasoner-tool-controller.ts` 注册工具
4. 在 `tests/contract/mcp-tools.test.ts` 添加契约测试

### 日志调试

#### 查看特定组件的日志

日志带 `component` 字段，可用 `jq` 过滤：

```bash
# 只看 Core 层日志
tail -f data/logs/reasoner-server.log | jq 'select(.component == "core")'

# 只看工具拒绝
tail -f data/logs/reasoner-server.log | jq 'select(.errorCode)'

# 监控 T2 违例（context stale）
tail -f data/logs/reasoner-server.log | jq 'select(.errorCode == "ContextStale")'
```

#### 关键诊断点

| 日志内容 | 触发条件 | 日志级别 |
|---------|---------|---------|
| `reclaimed expired leases` | claim 时发现过期租约 | `info` |
| `edge context stale at completion` | complete 时 hash 不匹配（**T2 核心保证**）| `warn` |
| `rejected edge completion: would create a cycle` | 完成会造成环 | `warn` |
| `mutation threw` | 存储事务异常（含 stack）| `error` |
| `recovery: structural violation` | 启动时检测到 DAG 违例 | `error` |

### 代码规范

- 使用 Prettier + ESLint（自动格式化）
- `exactOptionalPropertyTypes: true` — 严格区分 `undefined` 和缺失
- 所有错误通过 `Result<T>` 类型返回，不抛异常

## 故障排查

### 服务器无法启动

```bash
# 检查端口占用
netstat -ano | findstr 8791

# 查看详细错误
REASONER_LOG_LEVEL=debug node dist/main.js
```

### 前端连接失败

1. 确认服务器已启动：`curl http://127.0.0.1:8791/health`
2. 检查 CORS 配置（开发模式下自动允许）
3. 查看浏览器控制台网络请求

### 会话标记为 `StructurallyInvalid`

启动时自动运行 `validateRecoveredSessions()`，发现违例会将会话标记为不可恢复。检查日志：

```bash
jq 'select(.msg == "recovery: structural violation, session marked unschedulable")' \
   data/logs/reasoner-server.log
```

常见违例：
- `CyclicComponent` — 完成子图存在环（应被 `checkCycleOnComplete` 阻止）
- `SelfLoop` — 边的源包含自己的目标
- `DanglingReference` — 边引用不存在的顶点

## MCP 工具列表

| 工具名 | 功能 | 变更图状态 |
|--------|------|-----------|
| `create_reasoning_session` | 创建新会话 | ✅ |
| `get_reasoning_session` | 查询会话元数据 | ❌ |
| `list_reasoning_sessions` | 列出所有会话 | ❌ |
| `finish_reasoning_session` | 终止会话 | ✅ |
| `add_state_vertex` | 添加状态顶点 | ✅ |
| `add_evidence_vertex` | 添加证据顶点 | ✅ |
| `get_vertex` | 查询顶点 | ❌ |
| `propose_inference_edge` | 提出推理边 | ✅ |
| `get_inference_edge` | 查询边详情 | ❌ |
| `list_candidate_edges` | 列出待处理边 | ❌ |
| `claim_inference_edge` | 单边租约申请 | ✅ |
| `claim_inference_edges` | 批量租约申请（含过期回收）| ✅ |
| `release_inference_edge` | 释放租约 | ✅ |
| `complete_inference_edge` | 完成推理（含 cycle 检测）| ✅ |
| `block_inference_edge` | 标记不可达 | ✅ |
| `answer_evidence_question` | 回答证据问题 | ✅ |
| `get_context_for_vertex` | 获取顶点上下文（全局视角）| ❌ |
| `get_context_for_edge` | 获取边上下文（执行视角）| ❌ |
| `get_reasoning_context` | 获取完整推理上下文（含事件流）| ❌ |

## 许可证

MIT

## 贡献指南

欢迎提交 Issue 和 Pull Request！提交前请确保：

1. 所有测试通过：`pnpm test`
2. 代码格式化：`pnpm format`
3. 类型检查通过：`pnpm -r build`

---

**项目状态**: ✅ 核心功能完成 | 🧪 测试覆盖 42/42 通过 | 📝 日志系统已就绪

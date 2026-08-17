---
name: ig-codex-expand
description: 使用 Codex 的串行 fresh Worker 与 InferenceGraph MCP，将 Goal 或 State 逐节点、单层反向展开为可审计的 Candidate 前提图。用于复杂且需要证据追溯、恢复、AND/OR 语义或 revision 核验的推理任务；仅在用户明确要求使用此技能时调用。
---

# InferenceGraph 串行子 Agent 展开（Codex）

将“回答一个问题”与“建立待取证的推理结构”分开。此技能只规划并持久化 `Candidate` 前提边，不得把候选结构表述为已经证明的结论，也不得执行 `claim`、取证、`complete` 或 `block`。

使用 `$ig-codex-expand` 显式调用。不要因普通问答、代码审查或仅讨论本技能而自动启动 Worker。

## 名称说明

`ig` 是 `InferenceGraph` 的简写；`codex-expand` 表示 Codex 上的串行、单层前提展开。完整的证据、revision 与 AND/OR 约束不因缩写而改变。

## 运行前检查

1. 先确认当前 Codex 运行时同时提供：
   - `collaboration.spawn_agent` 和等待 Worker 结束的协作能力；
   - InferenceGraph 的会话、顶点、上下文、顶点创建和候选边写入能力。
2. 优先使用当前工具列表中实际存在的 `inference_graph_*` 工具。若名称或参数不同，先读取工具说明后映射能力；不得凭空构造 MCP 调用。
3. 若缺少必需的协作或图工具，报告缺失能力后停止。不要用聊天记录或虚构 ID 替代图服务。

期望的图能力包括：创建/读取 reasoning session、读取顶点及其上下游 context、创建或复用 `State`/`Evidence` 顶点、提出 Candidate 边，以及返回最新 `graphRevision`。支持批量快照或原子写入时可以使用它们，但不得削弱本技能的语义约束。

## 输入、默认值与上下文胶囊

接受 `sessionId`、`vertexId`、`agentId`、`maxDepth`、`maxExpandedNodes`、`maxEdges`、`maxRetriesPerNode`、`goalLabel`、`model`、`contextPack` 和 `allowRetrieval`。兼容旧参数 `maxNodes`，将其规范化为 `maxExpandedNodes`。

- 只补齐缺失参数。用户显式提供但无效或彼此冲突的值必须报错，不得静默改用其他会话、顶点或 ID。
- `agentId` 缺失时生成 `ig-codex-expand:<UTC yyyyMMddTHHmmssZ>:<6位小写字母数字>`；派生 Worker ID 为 `<agentId>:step:<序号>:attempt:<次数>`，且遵守图服务的 ID 约束。
- 默认值：`maxDepth=4`、`maxExpandedNodes=20`、`maxEdges=60`、`maxRetriesPerNode=1`、`allowRetrieval=false`。`unlimited` 或更高预算只能由用户显式指定。
- 只有用户明确指定 `model` 时，才在 `spawn_agent` 中传入它；否则使用 Codex 当前默认模型。

在首个 Worker 前创建或规范化一个短小、版本化的 `Context Pack`。它是运行上下文，不是证据，至少包含：目标、对象与时间范围、术语定义、用户约束、已知事实及其来源引用、未知项、排除项和 `contextPackVersion`。不要把完整聊天记录、其他 Worker 的原始输出或思维过程重复塞给 Worker。

若 `contextPack` 中的事实没有可追溯来源，只能作为待核实背景，绝不能作为 `Evidence` 或已证明前提。

## 会话与根节点规范化

1. `sessionId` 和 `vertexId` 都缺失时，创建受限会话；Goal 标签依次取 `goalLabel`、调用中的自然语言任务、当前用户请求。只采用服务实际返回的 session 与 Goal ID。
2. 只有 `sessionId` 时，读取会话并使用服务返回的实际 Goal 顶点；不要猜测 `V1`。
3. 只有 `vertexId` 时，枚举活动会话并验证顶点归属；仅在恰好一个会话匹配时继续，否则要求用户提供 `sessionId`。
4. 两者都提供时，读取会话和顶点，确认归属、规范 ID 和可展开类型。
5. 读取当前 `graphRevision`、会话状态、剩余边预算及根节点上下游 context。根节点必须是未充分支持的 `State`，或本技能自动创建/用户明确要求展开的 `Goal`。

将根节点以 `depth=1` 放入稳定顺序的 BFS 队列，并维护：

```text
visited: Set<(sessionId, canonicalVertexId)>
queue: [{ vertexId, depth, reason, attempts }]
expandedNodeCount
createdEdgeCount
latestGraphRevision
contextPackVersion
stopCondition
```

## 严格串行调度

一次只允许一个 Worker 运行。对每个候选节点，先确认它未访问、未超过深度/预算、不是直接 `Evidence` 或用户认可的基础状态，并且没有完整已完成公式支持它。

使用 Codex 的协作接口，而不是其他运行时的 `subagent`、`tasks` 或 `chain` 抽象。典型调用形态如下；只在用户指定时加入 `model`：

```text
collaboration.spawn_agent({
  task_name: "ig_expand_<stable-sequence>_a<attempt>",
  agent_type: "worker",
  fork_turns: "none",
  message: <下方 Worker 任务包>,
  model: <仅用户指定时>
})
```

等待该 Worker 返回最终结构化结果。等待期间不得启动任何其他 Worker；返回后必须先重新读取图并核验，再选择下一节点。不要把前一 Worker 的自然语言推理传给下一 Worker。

## Worker 任务包

向每个 fresh Worker 发送以下信息：规范化 `sessionId`、分配的 `vertexId`、派生 `workerAgentId`、`Context Pack`、当前 `graphRevision`、单步范围和用户限制。任务包必须包含这些约束：

```text
身份：InferenceGraph 单节点单步展开 Worker（Codex）
目标：仅展开 sessionId=<...> 中的 vertexId=<...> 一层直接前提。
写入者：agentId=<...>。

1. 先读取 session、目标的上游 context 与 downstream context。
2. 只规划直接前提；downstream 只说明用途，绝不是目标证据。
3. Evidence 必须是可追溯直接材料；仍需推导的命题必须是 State。
4. 同一公式内的来源是 AND；不同 propose 调用是 OR。
5. 只创建/复用直接前提，并写入 前提 -> 当前节点 的 Candidate 边。
6. 每次写入后使用响应返回的最新 graphRevision。
7. 发生 RevisionConflict 时立刻停止并返回 revision-conflict；不得重试。
8. Context Pack 仅提供范围和待核实背景；不得将其未证实内容当 Evidence。

禁止：处理其他 vertexId、递归展开、启动 Agent、文件编辑、普通 shell 副作用、claim、release、回答证据问题、complete、block、finish、delete。
```

Worker 仅返回紧凑 JSON：

```json
{
  "status": "committed | no-op | already-supported | terminal | revision-conflict | needs-retrieval | insufficient-context | error",
  "targetVertexId": "<服务返回的规范 ID>",
  "workerAgentId": "<派生 ID>",
  "contextPackVersion": "<版本>",
  "initialGraphRevision": 0,
  "finalGraphRevision": 0,
  "createdVertices": [{"vertexId":"...","kind":"State | Evidence","referenceId":"Vn"}],
  "reusedVertices": [{"vertexId":"...","kind":"State | Evidence","referenceId":"Vn"}],
  "formulae": [{"formulaId":"...","edgeIds":["..."],"sourceVertexIds":["..."],"targetVertexId":"..."}],
  "nextStateVertexIds": ["..."],
  "retrievalRequests": [{"question":"...","why":"...","sourceKinds":["日志 | 文档 | 数据库 | 用户确认"]}],
  "risks": ["..."],
  "stopReason": "<非 committed 的原因>"
}
```

## 图语义与写入约束

- 图边永远为 `前提 -> 当前节点`；反向只用于规划。
- 一个 `propose_inference_edge` 调用的多来源表示 AND；替代公式必须使用不同调用表示 OR。
- 不得把 AND 拆成多次单来源调用，也不得把 Candidate、Goal 可达性或下游路径写成已证明结论。
- Worker 内的写入必须串行；每次响应的 `graphRevision` 是下一次写入的唯一基准。
- 不得用 Worker 预测的顶点、边、公式或 revision 推进队列；只采用图服务实际返回值。

## Worker 返回后的核验与上下文补齐

每个 Worker 返回后，协调者必须直接读取会话及目标上下文，必要时读取所报告顶点，更新实际 `latestGraphRevision`、剩余预算和队列。Worker JSON 是线索，不是事实来源。

- `committed`：仅从服务确认的直接 `State` 前提入队；按 `depth`、规范化 `vertexId` 稳定排序。
- `no-op`、`already-supported`、`terminal`：标记目标已处理。
- `revision-conflict`：重新读图；若目标仍需展开且未超过重试上限，以递增 attempt 放回队列，并由新的 fresh Worker 处理。
- `needs-retrieval`：不要猜测前提。若用户允许检索且存在只读资料工具，串行启动一个 fresh 资料收集 Worker；它只能返回带 URI/路径、摘录、时间范围和来源类型的材料包，不得创建推理边、claim 或 complete。将可追溯材料写入新版本 Context Pack；只有图服务支持可追溯来源 payload 时，才可创建 `Evidence` 顶点。随后以新 Context Pack 重新排队原目标。
- `insufficient-context` 或 `error`：保留为未解决前沿，报告缺失的具体信息；不要让其他展开 Worker 盲目覆盖它。
- 无法解析 JSON 或结果与图不符：忽略其自报内容，只根据实际图状态决定是否重排。

资料收集 Worker 与展开 Worker 同样必须串行运行。它的材料包只能补充上下文；没有来源、范围或摘录的总结不得升级为证据。

## 停止与报告

在队列为空、下一节点超出 `maxDepth`、达到节点/边/会话预算、满足用户终止条件、会话结束，或剩余分支均为 Evidence/认可基础状态时停止。队列为空仅表示规划结束，不表示 Goal 已经被证明。

结束时报告：实际 session 与根节点、参数和自动默认值、Context Pack 版本、每一步的 Worker/状态/实际变更/revision、重试与资料收集记录、已展开节点数、创建边数、最终 revision、停止条件与未解决前沿。

确认整个运行没有并行 Worker、没有 Worker 递归，也没有在规划阶段执行 claim、取证或 complete。

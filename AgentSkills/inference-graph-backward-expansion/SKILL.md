---
name: inference-graph-backward-expansion
description: 对 InferenceGraph 中已有的 Goal 或 State 节点执行单步或递归反向展开，读取上下游语义后创建或复用直接前提，并建立前提指向当前节点的候选推理边。仅在用户显式调用时使用。
disable-model-invocation: true
---

# InferenceGraph Backward Expansion

仅在用户显式调用 `/skill:inference-graph-backward-expansion` 时执行本技能。该技能用于把一个已经存在的 InferenceGraph 节点反向规划为可验证的直接前提，再以正向方向持久化候选边。

反向只发生在规划阶段：从当前结论回看它需要什么前提。所有持久化边始终是 `前提 -> 当前节点`，并由后续正向取证和完成来验证。

## Scope And Inputs

从用户的调用中获取以下信息；缺少写入所需信息时先向用户询问，不要猜测：

- `sessionId`：InferenceGraph 会话 ID。
- `vertexId`：当前节点 ID 或会话内 `Vn` 引用。
- `agentId`：本次写操作的稳定 Agent ID。
- `mode`：`single-step` 或 `recursive`。

默认使用 `single-step`。只有用户明确要求“递归”“完整反向展开”或等价范围时才使用 `recursive`。递归模式还必须有明确的深度、预算或停止条件；没有时要求用户提供范围，避免无界地创建图结构。

本 Pi 配置中的 MCP 工具名称以 `inference_graph_` 为前缀。若工具不可用，先通过 MCP 搜索/描述确认名称和参数，不要凭空构造调用。

## Non-Negotiable Rules

1. 当前节点必须已存在。它通常是 `Goal` 或未支持的 `State`；不要把尚未验证的假设长期留作没有入边的孤立 `State`。
2. 每次展开都先读取上下游，不能仅凭节点标签直接写图。
3. 下游上下文只说明当前节点为何有用，绝不是证明当前节点成立的证据。
4. 一个候选公式是一组 AND 前提；多个独立公式组表达 OR。不要把 AND 前提拆成多次单来源写入。
5. `Evidence` 只用于可追溯的直接材料，例如日志、文档、数据库记录和外部系统响应。仍需推导的命题使用 `State`。
6. 所有写入串行执行。每次成功写入后，下一次写入的 `baseGraphRevision` 必须使用响应中的最新 `graphRevision`。
7. 本技能只负责规划和建立 `Candidate` 边。除非用户另行明确要求执行阶段，否则不要 claim、回答证据问题、complete、release 或 block 任何边。
8. 不得将下游结论、Goal 路径存在性或 `reachable=true` 当作当前节点已被证明的依据。

## Read Before Planning

对当前节点 `G` 执行下列只读操作：

1. 调用 `inference_graph_get_reasoning_session`，或其他能可靠返回当前 `graphRevision` 的只读接口，取得写入起始 revision。
2. 调用 `inference_graph_get_context_for_vertex(sessionId, G)`，阅读已有上游依赖、已有公式和证据摘要，避免重复或冲突建模。
3. 调用 `inference_graph_get_downstream_context_for_vertex(sessionId, G)`，阅读 `directDownstreamEdges`、`directDownstreamVertices` 与 `goalPathSummary`。

解释下游信息时遵守以下边界：

- `directDownstreamEdges` 和最短 Goal 路径只说明 `G` 正在支持哪些后续命题。
- 路径中的边可能是 `Candidate`、`Leased`、`Completed` 或 `Blocked`。
- 一个路径边还可能只是 AND 公式的一部分；通过 `formulaId` 判断完整公式，不能将线性路径误解为完整证明。
- 当 `G` 自身是 Goal 时，`hopCount=0` 只表示节点身份，不表示 Goal 已成立。

## Plan Direct Premise Formulae

先在不写图的情况下形成明确计划。每个候选公式包含：

- 直接前提列表：每项有 `kind`（`Evidence` 或 `State`）、精确标签、对象/时间范围 payload，以及需要时的稳定 `dedupeKey`。
- 公式关系：一个公式内的前提均为 AND；不同公式之间为 OR。
- 说明标签：为什么这组前提足以支持 `G`。
- 可选证据问题：用于验证该候选关系，而不是代替前提节点。

只选择能直接支持 `G` 的前提。若 `P2` 是 `P1` 的原因，则本轮建立 `P1 -> G`，不要错误地创建 `P2 -> G` 的捷径。

没有独立的 `Hypothesis` 顶点类型。待推导命题应成为 `State`，并在递归模式中继续建立其上游公式，直至落到可信 `Evidence` 或用户明确认可的基础状态。

## Create Or Reuse Premises

对每个计划前提执行以下流程：

1. 先从上游上下文和已知图信息中识别语义等价顶点；存在时复用其 ID。
2. 对尚不存在的直接材料调用 `inference_graph_add_evidence_vertex`。
3. 对尚不存在、仍需推导的中间命题调用 `inference_graph_add_state_vertex`。
4. 为新建顶点提供稳定且语义明确的 `dedupeKey`，以避免同一对象、范围和时间窗口重复建模。
5. 每次写入后保存返回的顶点 ID 与 `graphRevision`，再进行下一次写入。

若服务返回 `RevisionConflict`，停止使用旧 revision。重新读取当前 session/context，核对是否已有其他 Agent 创建等价结构，再以服务端最新 revision 重试必要的操作。

## Persist Formulae In The Correct Direction

创建或复用前提后，始终让前提指向当前节点 `G`：

```text
P1, P2, ... -> G
```

### AND Formula

当所有前提共同成立才支持 `G` 时，使用一次 `inference_graph_propose_inference_edge` 调用：

```json
{
  "sessionId": "<sessionId>",
  "agentId": "<agentId>",
  "baseGraphRevision": 123,
  "sourceVertexIds": ["<P1>", "<P2>"],
  "targetVertexIds": ["<G>"],
  "label": "P1 和 P2 共同支持 G"
}
```

服务会创建多条物理边，但它们共享同一个 `formulaId`，语义为 `P1 AND P2 -> G`。只有公式组内全部边完成，公式才可以正向支持 `G`。

### OR Formulae

当存在替代路径时，为每个候选公式分别调用一次 `inference_graph_propose_inference_edge`：

```text
P1 AND P2 -> G
OR
P3 -> G
```

对应为一次来源 `[P1, P2]` 的调用和一次来源 `[P3]` 的调用。不同调用得到不同 `formulaId`，任一完整公式都可支持 `G`。

### Evidence Questions

`evidenceQuestions` 写在 `propose_inference_edge` 时会复制到该批次创建的每条物理边。只有当同一问题适用于该公式的每条边时才在创建时提交。

若不同前提需要不同问题，先创建边，再在边仍为 `Candidate` 时分别调用 `inference_graph_update_inference_edge` 写入各自完整的问题列表。继续使用每次写入返回的最新 revision。

## Mode: Single Step

`single-step` 只处理用户指定的当前节点 `G`：

1. 读取 `G` 的上游和下游上下文。
2. 规划 `G` 的直接前提公式。
3. 创建或复用这些直接前提顶点。
4. 创建从前提到 `G` 的 `Candidate` 推理边。
5. 报告本轮创建/复用的顶点、公式组、物理边和最终 revision。

完成后立刻停止。不得为任何新前提继续寻找其前提，也不得领取、取证、完成或阻断刚创建的边。

## Mode: Recursive

`recursive` 在完成当前节点的一层展开后，才处理需要继续证明的前提：

1. 维护已访问节点集合，键为 `(sessionId, vertexId)`，避免重复展开和循环规划。
2. 仅将尚未有完整支持路径、且不是直接证据或用户明确认可基础状态的 `State` 前提加入待展开队列。
3. 对每个队列节点重复“Read Before Planning”“Create Or Reuse Premises”和“Persist Formulae In The Correct Direction”。
4. 遵守用户给出的深度、节点数、边数和停止条件；达到任一限制时停止并报告剩余前沿。
5. 当所有分支都落到可追溯 `Evidence` 或明确认可的基础状态时结束规划。

递归模式仍只建立候选结构。执行阶段应从底层候选边开始，另行进行 `list_candidate_edges`、claim、取证、complete 或 block；不要在展开过程中混入这些操作，除非用户明确要求一个单独的执行阶段。

## Completion Report

每次调用结束时，简洁报告：

- 执行模式、`sessionId` 和当前节点。
- 读取到的关键上下游约束，以及它们没有被用作证据的说明。
- 创建与复用的 `Evidence` / `State` 顶点。
- 每个新公式的 AND/OR 语义、`formulaId` 和对应物理边。
- 最终 `graphRevision`。
- 单步模式的明确停止确认，或递归模式的已展开范围、停止条件和剩余未解决前沿。
- 任何 `RevisionConflict`、去重结果、预算限制或无法确定的领域前提。

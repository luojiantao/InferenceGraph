import {
  buildInferenceFormulaGroups,
  type GraphAliases,
  type InferenceFormulaGroup,
  type InferenceEdge,
  type Vertex,
  type VertexExpansionContext,
} from '@reasoner/schema';

export interface RenderedVertexReasoningContext {
  readonly reasoningText: string;
  readonly mermaid: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareReferences = (left: string, right: string): number => {
  const leftNumber = Number(left.slice(1));
  const rightNumber = Number(right.slice(1));
  if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return compareText(left, right);
};

const escapeMermaidLabel = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\r\n', '<br/>')
    .replaceAll('\n', '<br/>');

const escapeMermaidEdgeLabel = (value: string): string =>
  escapeMermaidLabel(value).replaceAll('|', '&#124;');

const escapeMarkdownInline = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('\r\n', ' ')
    .replaceAll('\n', ' ');

const vertexClass = (vertex: Vertex, currentVertexId: string): string => {
  if (vertex.vertexId === currentVertexId) return 'current';
  if (vertex.kind === 'Goal') return 'goal';
  if (vertex.kind === 'Evidence') return 'evidence';
  return 'state';
};

const describeVertex = (vertex: Vertex, aliases: GraphAliases): string => {
  const reference = aliases.vertexById.get(vertex.vertexId) ?? vertex.vertexId;
  return `${reference} · ${vertex.label}`;
};

const getVertex = (vertices: ReadonlyMap<string, Vertex>, vertexId: string): Vertex | undefined =>
  vertices.get(vertexId);

const mermaidVertexNodeId = (vertex: Vertex, aliases: GraphAliases, fallbackIndex: number): string => {
  const reference = aliases.vertexById.get(vertex.vertexId) ?? vertex.vertexId;
  const match = /^V([1-9][0-9]*)$/.exec(reference);
  return match === null ? `v${fallbackIndex + 1}` : `v${match[1]}`;
};

const formulaExpression = (
  formula: InferenceFormulaGroup<InferenceEdge>,
  aliases: GraphAliases,
): string => {
  const edges = [...formula.edges].toSorted((left, right) =>
    compareReferences(
      aliases.edgeById.get(left.edgeId) ?? left.edgeId,
      aliases.edgeById.get(right.edgeId) ?? right.edgeId,
    ),
  );
  const edgeReferences = edges.map((edge) => aliases.edgeById.get(edge.edgeId) ?? edge.edgeId);
  const sourceReferences = edges.map((edge) => {
    const sourceId = edge.sourceVertexIds[0];
    return sourceId === undefined ? 'unknown-source' : (aliases.vertexById.get(sourceId) ?? sourceId);
  });
  const targetReference = aliases.vertexById.get(formula.targetVertexId) ?? formula.targetVertexId;
  return `${edgeReferences.join(' ∧ ')}: ${sourceReferences.join(' ∧ ')} -> ${targetReference}`;
};

/**
 * Keeps the visual graph self-describing: direct arrows retain their own En
 * labels, while the current target node states how those arrows compose.
 */
const formulaSummary = (
  formulae: readonly InferenceFormulaGroup<InferenceEdge>[],
  aliases: GraphAliases,
): string | undefined => {
  if (formulae.length === 0) return undefined;

  const summaries = formulae.map((formula) => {
    const edgeReferences = [...formula.edges]
      .toSorted((left, right) =>
        compareReferences(
          aliases.edgeById.get(left.edgeId) ?? left.edgeId,
          aliases.edgeById.get(right.edgeId) ?? right.edgeId,
        ),
      )
      .map((edge) => aliases.edgeById.get(edge.edgeId) ?? edge.edgeId)
      .join(' ∧ ');
    return formulae.length === 1 ? edgeReferences : `(${edgeReferences})`;
  });

  return summaries.join(' ∨ ');
};

/** Converts a vertex dependency projection into deterministic Mermaid and Markdown. */
export const renderVertexReasoningContext = (
  context: VertexExpansionContext,
  aliases: GraphAliases,
): RenderedVertexReasoningContext => {
  const vertexById = new Map<string, Vertex>();
  for (const vertex of context.ancestorVertices) vertexById.set(vertex.vertexId, vertex);
  vertexById.set(context.currentVertex.vertexId, context.currentVertex);
  // The session goal remains in the text header. The diagram itself must only
  // contain vertices belonging to the requested dependency projection.

  const vertices = [...vertexById.values()].sort((left, right) =>
    compareReferences(
      aliases.vertexById.get(left.vertexId) ?? left.vertexId,
      aliases.vertexById.get(right.vertexId) ?? right.vertexId,
    ),
  );
  const edges = [...context.ancestorEdges].sort((left, right) =>
    compareReferences(
      aliases.edgeById.get(left.edgeId) ?? left.edgeId,
      aliases.edgeById.get(right.edgeId) ?? right.edgeId,
    ),
  );
  const currentFormulae = buildInferenceFormulaGroups(edges).filter(
    (formula) => formula.targetVertexId === context.currentVertex.vertexId,
  );
  const currentFormulaSummary = formulaSummary(currentFormulae, aliases);

  const vertexNodeId = new Map<string, string>();
  vertices.forEach((vertex, index) =>
    vertexNodeId.set(vertex.vertexId, mermaidVertexNodeId(vertex, aliases, index)),
  );

  const mermaidLines = [
    'flowchart TD',
    '  %% 箭头方向表示来源顶点到目标顶点，边标签是独立推理边索引。',
    '  %% 仅绘制当前依赖投影中的顶点；会话目标只在它属于该投影时出现。',
  ];

  for (const vertex of vertices) {
    const nodeId = vertexNodeId.get(vertex.vertexId);
    if (nodeId === undefined) continue;
    const nodeLabel =
      vertex.vertexId === context.currentVertex.vertexId && currentFormulaSummary !== undefined
        ? `${describeVertex(vertex, aliases)}\n公式：${currentFormulaSummary}`
        : describeVertex(vertex, aliases);
    mermaidLines.push(
      `  ${nodeId}["${escapeMermaidLabel(nodeLabel)}"]:::${vertexClass(
        vertex,
        context.currentVertex.vertexId,
      )}`,
    );
  }

  for (const edge of edges) {
    const sourceNode = vertexNodeId.get(edge.sourceVertexIds[0] ?? '');
    const targetNode = vertexNodeId.get(edge.targetVertexIds[0] ?? '');
    if (sourceNode === undefined || targetNode === undefined) continue;
    const edgeReference = aliases.edgeById.get(edge.edgeId) ?? edge.edgeId;
    const edgeLabel = `${edgeReference} · ${edge.label}`;
    mermaidLines.push(`  ${sourceNode} -->|${escapeMermaidEdgeLabel(edgeLabel)}| ${targetNode}`);
  }
  for (const formula of currentFormulae) {
    mermaidLines.push(
      `  %% Current vertex formula (all conditions required): ${formulaExpression(formula, aliases)}`,
    );
  }

  mermaidLines.push('  classDef goal fill:#fef3c7,stroke:#b45309,color:#1f2937');
  mermaidLines.push(
    '  classDef current fill:#dbeafe,stroke:#2563eb,color:#111827,stroke-width:2px',
  );
  mermaidLines.push('  classDef state fill:#ecfccb,stroke:#4d7c0f,color:#1f2937');
  mermaidLines.push('  classDef evidence fill:#fce7f3,stroke:#be185d,color:#1f2937');
  const mermaid = mermaidLines.join('\n');

  const currentReference =
    aliases.vertexById.get(context.currentVertex.vertexId) ?? context.vertexId;
  const goalReference =
    aliases.vertexById.get(context.goalVertex.vertexId) ?? context.goalVertex.vertexId;
  const reasoningLines = [
    `# 顶点推理上下文：${escapeMarkdownInline(currentReference)}`,
    '',
    `- 会话：\`${escapeMarkdownInline(context.sessionId)}\`，图 revision：${context.graphRevision}`,
    `- 当前焦点：${escapeMarkdownInline(describeVertex(context.currentVertex, aliases))}（${context.currentVertex.kind}）`,
    `- 会话目标：${escapeMarkdownInline(goalReference)} · ${escapeMarkdownInline(context.goalVertex.label)}`,
    `- 投影策略：\`${context.policy}\``,
    '',
    '## 当前顶点推理公式',
  ];

  if (currentFormulae.length === 0) {
    reasoningLines.push('当前顶点没有入边推理公式。');
  } else {
    reasoningLines.push(
      currentFormulae.length === 1
        ? '该公式内的全部条件都必须完成，当前顶点才被推出。'
        : '每个公式组内的全部条件都必须完成；任一公式组成立即可推出当前顶点。',
    );
    currentFormulae.forEach((formula, index) => {
      const completed = formula.edges.filter((edge) => edge.state === 'Completed').length;
      reasoningLines.push(`${index + 1}. ${escapeMarkdownInline(formulaExpression(formula, aliases))}`);
      reasoningLines.push(`   - 条件完成：${completed}/${formula.edges.length}`);
    });
  }

  reasoningLines.push('', '## 图中推理关系');

  if (edges.length === 0) {
    reasoningLines.push('该投影内没有通向当前焦点的推理边。');
  } else {
    edges.forEach((edge, index) => {
      const sourceText = edge.sourceVertexIds
        .map((vertexId) => getVertex(vertexById, vertexId))
        .filter((vertex): vertex is Vertex => vertex !== undefined)
        .map((vertex) => escapeMarkdownInline(describeVertex(vertex, aliases)))
        .join(' + ');
      const targetText = edge.targetVertexIds
        .map((vertexId) => getVertex(vertexById, vertexId))
        .filter((vertex): vertex is Vertex => vertex !== undefined)
        .map((vertex) => escapeMarkdownInline(describeVertex(vertex, aliases)))
        .join(' + ');
      const edgeReference = aliases.edgeById.get(edge.edgeId) ?? edge.edgeId;

      reasoningLines.push(
        `${index + 1}. ${escapeMarkdownInline(edgeReference)}：${sourceText} -> ${targetText}`,
      );
      reasoningLines.push(`   - 边状态：${edge.state}`);
      reasoningLines.push(`   - 推理关系：${escapeMarkdownInline(edge.label)}`);
      if (edge.conclusion !== undefined) {
        reasoningLines.push(`   - 已记录结论：${escapeMarkdownInline(edge.conclusion)}`);
      }
      for (const question of edge.evidenceQuestions) {
        const answer = question.answer === undefined ? '未回答' : question.answer;
        reasoningLines.push(
          `   - 证据问答：${escapeMarkdownInline(question.prompt)}；回答：${escapeMarkdownInline(answer)}`,
        );
      }
    });
  }

  reasoningLines.push('', '## 范围说明');
  reasoningLines.push(
    `包含当前顶点与 ${context.ancestorVertices.length} 个上游顶点、${edges.length} 条推理边；` +
      `省略 ${context.omittedVertexIds.length} 个顶点、${context.omittedEdgeIds.length} 条边。`,
  );
  if (context.globalSummary !== undefined) {
    const edgeStates = Object.entries(context.globalSummary.edgeCountByState)
      .sort(([left], [right]) => compareText(left, right))
      .map(([state, count]) => `${state}: ${count}`)
      .join('，');
    reasoningLines.push(
      `全图概况：${context.globalSummary.vertexCount} 个顶点；边状态 ${edgeStates || '无'}；` +
        `目标状态 ${context.globalSummary.goalState}。`,
    );
  }

  reasoningLines.push('', '## Mermaid 图', '', '```mermaid', mermaid, '```');
  reasoningLines.push('', '该文本仅转写当前图中已记录的顶点、边和证据问答，不新增事实或推理结论。');

  return { reasoningText: reasoningLines.join('\n'), mermaid };
};

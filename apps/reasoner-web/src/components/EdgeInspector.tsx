import type { ReactElement } from 'react';
import { useGraphStore } from '../state/graph-store.js';

const STATE_LABELS: Record<string, string> = {
  Candidate: '候选',
  Leased: '已领取',
  Completed: '已完成',
  Blocked: '已阻塞',
  Abandoned: '已放弃',
  Invalid: '结构无效',
};

/**
 * Edge detail with its evidence questions rendered as edge attributes. Questions
 * are never promoted to vertices or edges of their own.
 */
export const EdgeInspector = (): ReactElement => {
  const view = useGraphStore((state) => state.view);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectVertex = useGraphStore((state) => state.selectVertex);

  if (view === null) return <p className="muted">尚未加载会话。</p>;
  if (selectedEdgeId === null) {
    return <p className="muted">在画布或前沿中选择一条推理边以查看详情。</p>;
  }

  const edge = view.snapshot.edges.find((candidate) => candidate.edgeId === selectedEdgeId);
  if (edge === undefined) {
    return <p className="muted">这条边已不在当前快照中。</p>;
  }

  const vertexLabel = (vertexId: string): string =>
    view.snapshot.vertices.find((vertex) => vertex.vertexId === vertexId)?.label ?? vertexId;

  return (
    <section className="panel" aria-labelledby="edge-heading">
      <h2 id="edge-heading">推理边</h2>
      <p className="row-title">{edge.label}</p>

      <dl className="kv">
        <dt>状态</dt>
        <dd>
          <span className={`chip state-${edge.state}`}>
            {STATE_LABELS[edge.state] ?? edge.state}
          </span>
        </dd>
        <dt>成本 / 优先级</dt>
        <dd>
          {edge.cost} / {edge.priority}
        </dd>
        <dt>提出者</dt>
        <dd>{edge.proposedByAgentId}</dd>
        <dt>修订版本</dt>
        <dd>
          创建 r{edge.createdAtRevision} · 更新 r{edge.updatedAtRevision}
        </dd>
        {edge.lease !== undefined && (
          <>
            <dt>租约</dt>
            <dd>
              {edge.lease.agentId}
              <br />
              <span className="muted small">至 {edge.lease.expiresAt}</span>
            </dd>
          </>
        )}
        {edge.blockedReason !== undefined && (
          <>
            <dt>阻塞原因</dt>
            <dd>{edge.blockedReason}</dd>
          </>
        )}
        {edge.conclusion !== undefined && (
          <>
            <dt>结论</dt>
            <dd>{edge.conclusion}</dd>
          </>
        )}
      </dl>

      <h3>来源顶点（AND：全部前提需满足）</h3>
      <ul className="link-list">
        {edge.sourceVertexIds.map((vertexId) => (
          <li key={vertexId}>
            <button type="button" className="link" onClick={() => selectVertex(vertexId)}>
              {vertexLabel(vertexId)}
            </button>
          </li>
        ))}
      </ul>

      <h3>目标顶点</h3>
      <ul className="link-list">
        {edge.targetVertexIds.map((vertexId) => (
          <li key={vertexId}>
            <button type="button" className="link" onClick={() => selectVertex(vertexId)}>
              {vertexLabel(vertexId)}
            </button>
          </li>
        ))}
      </ul>

      <h3>
        取证问题 <span className="badge">{edge.evidenceQuestions.length}</span>
      </h3>
      {edge.evidenceQuestions.length === 0 ? (
        <p className="muted small">这条边没有取证问题。</p>
      ) : (
        <ul className="question-list">
          {edge.evidenceQuestions.map((question) => (
            <li
              key={question.questionId}
              className={question.answer === undefined ? 'open' : 'answered'}
            >
              <p className="question-text">{question.prompt}</p>
              <p className="muted small">
                {question.answer === undefined
                  ? '待回答'
                  : `由 ${question.answeredByAgentId ?? '未知'} 回答于 r${question.answeredAtRevision ?? '?'}`}
              </p>
              {question.answer !== undefined && <p className="answer">{question.answer}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

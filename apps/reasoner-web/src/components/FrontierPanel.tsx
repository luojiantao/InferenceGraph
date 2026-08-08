import type { ReactElement } from 'react';
import type { EdgeId } from '@reasoner/schema';
import { useGraphStore } from '../state/graph-store.js';

/**
 * The candidate frontier in the exact order Core's strategy returns it, so the
 * UI never re-sorts and never disagrees with what an agent would be handed next.
 */
export const FrontierPanel = (): ReactElement => {
  const view = useGraphStore((state) => state.view);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectEdge = useGraphStore((state) => state.selectEdge);

  if (view === null) return <p className="muted">尚未加载会话。</p>;

  const byId = new Map(view.snapshot.edges.map((edge) => [edge.edgeId, edge]));
  const frontier = view.frontierEdgeIds;

  return (
    <section className="panel" aria-labelledby="frontier-heading">
      <h2 id="frontier-heading">
        候选前沿 <span className="badge">{frontier.length}</span>
      </h2>
      <p className="muted small">策略：{view.snapshot.session.strategy}</p>

      {frontier.length === 0 ? (
        <p className="muted">当前没有候选边。外部 Agent 可以提出新的推理边。</p>
      ) : (
        <ol className="frontier-list">
          {frontier.map((edgeId: EdgeId, index) => {
            const edge = byId.get(edgeId);
            if (edge === undefined) return null;
            return (
              <li key={edgeId}>
                <button
                  type="button"
                  className={edgeId === selectedEdgeId ? 'row selected' : 'row'}
                  onClick={() => selectEdge(edgeId)}
                  aria-current={edgeId === selectedEdgeId}
                >
                  <span className="rank">{index + 1}</span>
                  <span className="row-main">
                    <span className="row-title">{edge.label}</span>
                    <span className="muted small">
                      cost {edge.cost} · priority {edge.priority}
                      {edge.evidenceQuestions.length > 0
                        ? ` · ${
                            edge.evidenceQuestions.filter(
                              (question) => question.answer === undefined,
                            ).length
                          }/${edge.evidenceQuestions.length} 待答`
                        : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};

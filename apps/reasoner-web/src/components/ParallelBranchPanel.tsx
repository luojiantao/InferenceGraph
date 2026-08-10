import type { ReactElement } from 'react';
import { useGraphStore } from '../state/graph-store.js';
import { buildGraphAliases } from './graph-aliases.js';

/** Live lease view: which agent holds which edge, and when that lease expires. */
export const ParallelBranchPanel = (): ReactElement => {
  const view = useGraphStore((state) => state.view);
  const selectEdge = useGraphStore((state) => state.selectEdge);

  if (view === null) return <p className="muted">尚未加载会话。</p>;

  const aliases = buildGraphAliases(view.snapshot);
  const leased = view.snapshot.edges.filter((edge) => edge.state === 'Leased');
  const byAgent = new Map<string, typeof leased>();
  for (const edge of leased) {
    const agentId = edge.lease?.agentId ?? '未知 Agent';
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), edge]);
  }

  return (
    <section className="panel" aria-labelledby="branch-heading">
      <h2 id="branch-heading">
        并行分支 <span className="badge">{leased.length}</span>
      </h2>

      {leased.length === 0 ? (
        <p className="muted">当前没有被领取的推理边。</p>
      ) : (
        <ul className="branch-list">
          {[...byAgent.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([agentId, edges]) => (
              <li key={agentId}>
                <p className="row-title">
                  {agentId} <span className="badge">{edges.length}</span>
                </p>
                <ul className="link-list">
                  {edges.map((edge) => (
                    <li key={edge.edgeId}>
                      <button
                        type="button"
                        className="link"
                        onClick={() => selectEdge(edge.edgeId)}
                      >
                        {aliases.edgeById.get(edge.edgeId) ?? edge.edgeId} · {edge.label}
                      </button>
                      {edge.lease !== undefined && (
                        <span className="muted small"> · 到期 {edge.lease.expiresAt}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
        </ul>
      )}

      <p className="muted small">
        同一条边同一时刻只能存在一个有效租约；过期回收与下一次领取发生在同一事务内。
      </p>
    </section>
  );
};

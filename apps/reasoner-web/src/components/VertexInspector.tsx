import type { ReactElement } from 'react';
import { useGraphStore, type GraphScope } from '../state/graph-store.js';
import { buildGraphAliases } from './graph-aliases.js';
import { buildIncomingInferenceFormulas } from './inference-formulas.js';

const SCOPE_OPTIONS: readonly { readonly id: GraphScope; readonly label: string }[] = [
  { id: 'All', label: '完整图' },
  { id: 'CurrentVertex', label: '当前节点' },
  { id: 'Dependencies', label: '到当前节点' },
];

/** Vertex detail, including the opaque agent-supplied payload verbatim. */
export const VertexInspector = (): ReactElement => {
  const view = useGraphStore((state) => state.view);
  const selectedVertexId = useGraphStore((state) => state.selectedVertexId);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const graphScope = useGraphStore((state) => state.graphScope);
  const setGraphScope = useGraphStore((state) => state.setGraphScope);

  if (view === null) return <p className="muted">尚未加载会话。</p>;
  if (selectedVertexId === null) return <p className="muted">选择一个顶点以查看详情。</p>;

  const vertex = view.snapshot.vertices.find((item) => item.vertexId === selectedVertexId);
  if (vertex === undefined) return <p className="muted">这个顶点已不在当前快照中。</p>;

  const incoming = view.snapshot.edges.filter((edge) =>
    edge.targetVertexIds.includes(selectedVertexId),
  );
  const outgoing = view.snapshot.edges.filter((edge) =>
    edge.sourceVertexIds.includes(selectedVertexId),
  );
  const incomingFormulas = buildIncomingInferenceFormulas(view.snapshot, selectedVertexId);
  const aliases = buildGraphAliases(view.snapshot);
  const vertexAlias = aliases.vertexById.get(vertex.vertexId) ?? vertex.vertexId;
  const isGoal = vertex.vertexId === view.snapshot.session.goalVertexId;

  return (
    <section className="panel" aria-labelledby="vertex-heading">
      <h2 id="vertex-heading">
        顶点 {vertexAlias}
        {isGoal ? '（目标）' : ''}
      </h2>
      <p className="row-title">{vertex.label}</p>

      <div className="segmented-control" role="group" aria-label="节点图范围">
        {SCOPE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={graphScope === option.id ? 'active' : ''}
            aria-pressed={graphScope === option.id}
            onClick={() => setGraphScope(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="vertex-reasoning">
        <h3>节点推理</h3>
        {incomingFormulas.length === 0 ? (
          <p className="muted small">无入边推理。</p>
        ) : (
          <ol className="inference-formula-list">
            {incomingFormulas.map((formula) => (
              <li key={formula.edgeId}>
                <button
                  type="button"
                  className="inference-formula"
                  aria-label={`查看推理边 ${formula.edgeId}`}
                  onClick={() => selectEdge(formula.edgeId)}
                >
                  <code>{formula.expression}</code>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <dl className="kv">
        <dt>类型</dt>
        <dd>{vertex.kind}</dd>
        <dt>创建者</dt>
        <dd>{vertex.createdByAgentId}</dd>
        <dt>创建修订</dt>
        <dd>r{vertex.createdAtRevision}</dd>
        <dt>入度 / 出度</dt>
        <dd>
          {incoming.length} / {outgoing.length}
        </dd>
      </dl>

      {Object.keys(vertex.payload).length > 0 && (
        <>
          <h3>载荷</h3>
          <pre className="payload">{JSON.stringify(vertex.payload, null, 2)}</pre>
        </>
      )}

      <h3>出边</h3>
      {outgoing.length === 0 ? (
        <p className="muted small">无出边。</p>
      ) : (
        <ul className="link-list">
          {outgoing.map((edge) => (
            <li key={edge.edgeId}>
              <button type="button" className="link" onClick={() => selectEdge(edge.edgeId)}>
                {aliases.edgeGroupById.get(edge.edgeId) ?? edge.edgeId} · {edge.label}
              </button>{' '}
              <span className={`chip state-${edge.state}`}>{edge.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

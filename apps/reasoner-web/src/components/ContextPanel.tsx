import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  EdgeExecutionContext,
  ExpansionHandle,
  GlobalNavigationSummary,
  VertexExpansionContext,
} from '@reasoner/schema';
import { reasonerApi, ReasonerRequestError } from '../api/client.js';
import { useGraphStore } from '../state/graph-store.js';

const Handles = ({ handles }: { handles: readonly ExpansionHandle[] }): ReactElement => (
  <>
    <h3>
      扩展句柄 <span className="badge">{handles.length}</span>
    </h3>
    {handles.length === 0 ? (
      <p className="muted small">没有可用的扩展句柄。</p>
    ) : (
      <ul className="handle-list">
        {handles.map((handle) => (
          <li key={handle.handleId}>
            <span className="mono small">{handle.policy}</span>
            <br />
            {handle.description}
          </li>
        ))}
      </ul>
    )}
  </>
);

const Omissions = ({
  vertexIds,
  edgeIds,
}: {
  vertexIds: readonly string[];
  edgeIds: readonly string[];
}): ReactElement => (
  <>
    <h3>遗漏</h3>
    {vertexIds.length === 0 && edgeIds.length === 0 ? (
      <p className="muted small">投影完整，没有遗漏对象。</p>
    ) : (
      <p className="muted small">
        遗漏 {vertexIds.length} 个顶点、{edgeIds.length} 条边。这是投影策略的有意裁剪，可通过扩展句柄补齐。
      </p>
    )}
  </>
);

const Summary = ({ summary }: { summary: GlobalNavigationSummary }): ReactElement => (
  <>
    <h3>全局导航摘要</h3>
    <ul className="stat-list">
      <li>
        顶点总数 <strong>{summary.vertexCount}</strong>
      </li>
      <li>
        目标状态 <strong>{summary.goalState}</strong>
      </li>
      <li>
        前沿边 <strong>{summary.frontierEdgeIds.length}</strong>
      </li>
      <li>
        已完成深度 <strong>{summary.maxCompletedDepth}</strong>
      </li>
    </ul>
    <ul className="stat-list">
      {Object.entries(summary.edgeCountByState).map(([state, count]) => (
        <li key={state}>
          {state} <strong>{count}</strong>
        </li>
      ))}
    </ul>
  </>
);

const EdgeContextView = ({ context }: { context: EdgeExecutionContext }): ReactElement => (
  <>
    <dl className="kv">
      <dt>策略</dt>
      <dd>{context.policy}</dd>
      <dt>修订版本</dt>
      <dd>r{context.graphRevision}</dd>
      <dt>边输入哈希</dt>
      <dd className="mono small" title={context.contextHash}>
        {context.contextHash.slice(0, 16)}…
      </dd>
    </dl>
    <p className="muted small">
      该哈希只覆盖这条边自身的来源、目标、标签、成本与取证问题；图上其他位置的推进不会使它失效。
    </p>
    <h3>包含</h3>
    <ul className="stat-list">
      <li>
        来源顶点 <strong>{context.sourceVertices.length}</strong>
      </li>
      <li>
        目标顶点 <strong>{context.targetVertices.length}</strong>
      </li>
      <li>
        祖先顶点 <strong>{context.ancestorVertices.length}</strong>
      </li>
      <li>
        祖先边 <strong>{context.ancestorEdges.length}</strong>
      </li>
      <li>
        取证问题 <strong>{context.evidenceQuestions.length}</strong>
      </li>
    </ul>
    <Omissions vertexIds={context.omittedVertexIds} edgeIds={context.omittedEdgeIds} />
    <Handles handles={context.expansionHandles} />
    {context.globalSummary !== undefined && <Summary summary={context.globalSummary} />}
  </>
);

const VertexContextView = ({ context }: { context: VertexExpansionContext }): ReactElement => (
  <>
    <dl className="kv">
      <dt>策略</dt>
      <dd>{context.policy}</dd>
      <dt>修订版本</dt>
      <dd>r{context.graphRevision}</dd>
      <dt>上下文哈希</dt>
      <dd className="mono small" title={context.contextHash}>
        {context.contextHash.slice(0, 16)}…
      </dd>
    </dl>
    <h3>包含</h3>
    <ul className="stat-list">
      <li>
        祖先顶点 <strong>{context.ancestorVertices.length}</strong>
      </li>
      <li>
        祖先边 <strong>{context.ancestorEdges.length}</strong>
      </li>
      <li>
        证据摘要 <strong>{context.evidenceDigests.length}</strong>
      </li>
    </ul>
    {context.evidenceDigests.length > 0 && (
      <ul className="link-list">
        {context.evidenceDigests.map((digest) => (
          <li key={digest.vertexId}>
            {digest.label}{' '}
            <span className="muted small">支撑 {digest.supportedEdgeIds.length} 条边</span>
          </li>
        ))}
      </ul>
    )}
    <Omissions vertexIds={context.omittedVertexIds} edgeIds={context.omittedEdgeIds} />
    <Handles handles={context.expansionHandles} />
    {context.globalSummary !== undefined && <Summary summary={context.globalSummary} />}
  </>
);

type ContextQueryData =
  | { readonly kind: 'Edge'; readonly context: EdgeExecutionContext }
  | { readonly kind: 'Vertex'; readonly context: VertexExpansionContext };

/**
 * Shows the exact projection Core would hand an agent for the current selection,
 * including what was deliberately omitted and which expansion handles remain.
 * Reads go through the same tool bridge an agent uses, so the UI can never show
 * a projection an agent would not receive.
 */
export const ContextPanel = (): ReactElement => {
  const sessionId = useGraphStore((state) => state.sessionId);
  const selectionKind = useGraphStore((state) => state.selectionKind);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectedVertexId = useGraphStore((state) => state.selectedVertexId);
  const revision = useGraphStore((state) => state.appliedRevision);

  const query = useQuery<ContextQueryData>({
    queryKey: ['context', sessionId, selectionKind, selectedEdgeId, selectedVertexId, revision],
    enabled: sessionId !== null && selectionKind !== null,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<ContextQueryData> => {
      if (sessionId === null) throw new Error('no session');
      if (selectionKind === 'Edge' && selectedEdgeId !== null) {
        const output = await reasonerApi.getContextForEdge(sessionId, selectedEdgeId, signal);
        return { kind: 'Edge' as const, context: output.context };
      }
      if (selectionKind === 'Vertex' && selectedVertexId !== null) {
        const output = await reasonerApi.getContextForVertex(sessionId, selectedVertexId, signal);
        return { kind: 'Vertex' as const, context: output.context };
      }
      throw new Error('no selection');
    },
  });

  if (selectionKind === null) {
    return <p className="muted">选择一条边或一个顶点以查看上下文投影。</p>;
  }
  if (query.isPending) return <p className="muted">正在加载投影…</p>;
  if (query.isError) {
    const code =
      query.error instanceof ReasonerRequestError ? query.error.apiError.code : 'NetworkError';
    return (
      <div className="error-box" role="alert">
        <p>无法加载上下文投影。</p>
        <p className="muted small">错误码：{code}</p>
        <button type="button" className="link" onClick={() => void query.refetch()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <section className="panel" aria-labelledby="context-heading">
      <h2 id="context-heading">上下文投影</h2>
      {query.data.kind === 'Edge' ? (
        <EdgeContextView context={query.data.context} />
      ) : (
        <VertexContextView context={query.data.context} />
      )}
    </section>
  );
};

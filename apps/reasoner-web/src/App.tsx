import type { ReactElement } from 'react';
import { useGraphStore } from './state/graph-store.js';
import { useReasoningContext } from './state/use-reasoning-context.js';
import { SessionToolbar } from './components/SessionToolbar.js';
import { GraphCanvas } from './components/GraphCanvas.js';
import { FrontierPanel } from './components/FrontierPanel.js';
import { EdgeInspector } from './components/EdgeInspector.js';
import { VertexInspector } from './components/VertexInspector.js';
import { ContextPanel } from './components/ContextPanel.js';
import { ParallelBranchPanel } from './components/ParallelBranchPanel.js';
import { EventTimeline } from './components/EventTimeline.js';

/**
 * Status view puts the graph and the frontier first; Audit view adds the full
 * event timeline and projection detail. Both read the same polled snapshot.
 */
export const App = (): ReactElement => {
  const sessionId = useGraphStore((state) => state.sessionId);
  const viewMode = useGraphStore((state) => state.viewMode);
  const view = useGraphStore((state) => state.view);
  const selectionKind = useGraphStore((state) => state.selectionKind);
  const query = useReasoningContext(sessionId);

  return (
    <div className="app">
      <SessionToolbar />

      {sessionId === null ? (
        <main className="empty" role="status">
          <h1>选择一个推理会话</h1>
          <p className="muted">
            尚未选择会话。使用工具栏的下拉框选择，或通过 MCP 调用 <code>create_reasoning_session</code> 新建。
          </p>
        </main>
      ) : query.isError && view === null ? (
        <main className="empty error" role="alert">
          <h1>无法读取推理图</h1>
          <p className="muted">
            服务未响应。确认 Reasoner Server 正在运行，UI 会自动重试。
          </p>
          <p className="mono small">{query.error instanceof Error ? query.error.message : '未知错误'}</p>
        </main>
      ) : view === null ? (
        <main className="empty" role="status">
          <h1>加载中…</h1>
          <p className="muted">正在读取快照与事件。</p>
        </main>
      ) : (
        <main className={`layout layout-${viewMode.toLowerCase()}`}>
          <section className="pane pane-canvas" aria-label="推理图画布">
            <GraphCanvas />
          </section>

          <aside className="pane pane-side" aria-label="检查器">
            <FrontierPanel />
            {selectionKind === 'Edge' && <EdgeInspector />}
            {selectionKind === 'Vertex' && <VertexInspector />}
            {selectionKind === null && (
              <p className="muted small pad">在画布或前沿列表中选择一个顶点或推理边查看详情。</p>
            )}
            <ParallelBranchPanel />
          </aside>

          {viewMode === 'Audit' && (
            <aside className="pane pane-audit" aria-label="审计">
              <ContextPanel />
              <EventTimeline />
            </aside>
          )}
        </main>
      )}
    </div>
  );
};

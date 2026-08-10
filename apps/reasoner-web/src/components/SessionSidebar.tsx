import { useState, type ReactElement } from 'react';
import { useGraphStore } from '../state/graph-store.js';
import { useSessions } from '../state/use-reasoning-context.js';

/** Persistent session navigation for the left edge of the workspace. */
export const SessionSidebar = (): ReactElement => {
  const [collapsed, setCollapsed] = useState(false);
  const sessionId = useGraphStore((state) => state.sessionId);
  const setSessionId = useGraphStore((state) => state.setSessionId);
  const view = useGraphStore((state) => state.view);
  const sessions = useSessions();
  const session = view?.snapshot.session;

  const toggleLabel = collapsed ? '展开会话管理' : '收起会话管理';

  return (
    <aside
      className={collapsed ? 'session-sidebar is-collapsed' : 'session-sidebar'}
      aria-label="会话管理"
    >
      <div className="session-sidebar-header">
        {!collapsed && <span className="brand">Reasoner</span>}
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          aria-controls="session-sidebar-content"
          title={toggleLabel}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
        </button>
      </div>

      {!collapsed && (
        <div id="session-sidebar-content" className="session-sidebar-content">
          <section className="sidebar-section" aria-labelledby="session-list-heading">
            <div className="sidebar-section-heading">
              <h1 id="session-list-heading">会话管理</h1>
              {!sessions.isPending && (
                <span className="muted small">{sessions.data?.sessions.length ?? 0}</span>
              )}
            </div>

            <ul className="session-list" aria-label="推理会话列表">
              {sessions.isPending && <li className="sidebar-empty muted small">正在加载会话…</li>}
              {sessions.isError && (
                <li className="sidebar-empty error-text small">无法读取会话列表</li>
              )}
              {!sessions.isPending &&
                !sessions.isError &&
                (sessions.data?.sessions.length ?? 0) === 0 && (
                  <li className="sidebar-empty muted small">暂无推理会话</li>
                )}
              {(sessions.data?.sessions ?? []).map((item) => {
                const selected = item.sessionId === sessionId;
                return (
                  <li key={item.sessionId}>
                    <button
                      type="button"
                      className={selected ? 'session-list-item selected' : 'session-list-item'}
                      aria-current={selected ? 'page' : undefined}
                      title={item.sessionId}
                      onClick={() => setSessionId(item.sessionId)}
                    >
                      <span className="mono session-list-id">{item.sessionId}</span>
                      <span className={`session-list-state goal-${item.goalState}`}>
                        {item.goalState}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="sidebar-section" aria-labelledby="current-session-heading">
            <div className="sidebar-section-heading">
              <h2 id="current-session-heading">当前会话</h2>
              {sessionId !== null && (
                <button
                  type="button"
                  className="sidebar-clear"
                  onClick={() => setSessionId(null)}
                  title="取消当前会话选择"
                >
                  清除
                </button>
              )}
            </div>

            {session === undefined ? (
              <p className="sidebar-empty muted small">
                {sessionId === null ? '选择会话后显示图版本和事件游标。' : '正在读取会话快照…'}
              </p>
            ) : (
              <dl className="sidebar-session-summary">
                <dt>状态</dt>
                <dd className={`goal-${session.goalState}`}>{session.goalState}</dd>
                <dt>图版本</dt>
                <dd className="mono">r{session.graphRevision}</dd>
                <dt>事件</dt>
                <dd className="mono">#{session.lastEventSeq}</dd>
              </dl>
            )}
          </section>
        </div>
      )}
    </aside>
  );
};

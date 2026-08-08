import type { ReactElement } from 'react';
import { useGraphStore, type ViewMode } from '../state/graph-store.js';
import { useSessions } from '../state/use-reasoning-context.js';

const VIEW_MODES: readonly { id: ViewMode; label: string }[] = [
  { id: 'Status', label: '状态主视图' },
  { id: 'Audit', label: '完整审计视图' },
];

/** Session picker, view-mode switch and connection status. */
export const SessionToolbar = (): ReactElement => {
  const sessionId = useGraphStore((state) => state.sessionId);
  const setSessionId = useGraphStore((state) => state.setSessionId);
  const viewMode = useGraphStore((state) => state.viewMode);
  const setViewMode = useGraphStore((state) => state.setViewMode);
  const view = useGraphStore((state) => state.view);
  const connection = useGraphStore((state) => state.connection);
  const staleDrops = useGraphStore((state) => state.staleDropCount);

  const sessions = useSessions();

  const session = view?.snapshot.session;

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <span className="brand">Reasoner</span>
        <label htmlFor="session-select" className="muted small">
          会话
        </label>
        <select
          id="session-select"
          value={sessionId ?? ''}
          onChange={(event) => setSessionId(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">
            {sessions.isPending ? '加载中…' : sessions.data?.sessions.length === 0 ? '无会话' : '请选择'}
          </option>
          {(sessions.data?.sessions ?? []).map((item) => (
            <option key={item.sessionId} value={item.sessionId}>
              {item.sessionId} · {item.goalState}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-group" role="group" aria-label="视图模式">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={mode.id === viewMode ? 'tab active' : 'tab'}
            aria-pressed={mode.id === viewMode}
            onClick={() => setViewMode(mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div className="toolbar-group toolbar-right">
        {session !== undefined && (
          <>
            <span className={`chip goal-${session.goalState}`}>{session.goalState}</span>
            <span className="muted small mono">r{session.graphRevision}</span>
            <span className="muted small">#{session.lastEventSeq}</span>
          </>
        )}
        {staleDrops > 0 && (
          <span className="muted small" title="已丢弃的乱序快照数量">
            乱序丢弃 {staleDrops}
          </span>
        )}
        <span className={`conn conn-${connection}`} role="status">
          {connection === 'Live' ? '已连接' : connection === 'Reconnecting' ? '重连中…' : '已断开'}
        </span>
      </div>
    </header>
  );
};

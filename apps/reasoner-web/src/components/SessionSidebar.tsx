import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReasoningSession } from '@reasoner/schema';
import { ReasonerRequestError, reasonerApi } from '../api/client.js';
import { useGraphStore } from '../state/graph-store.js';
import { useSessions } from '../state/use-reasoning-context.js';

const MAX_TAGS = 12;

const toTagList = (value: string): string[] => {
  const tags = new Set<string>();
  for (const candidate of value.split(/[，,]/)) {
    const tag = candidate.trim();
    if (tag.length > 0) tags.add(tag);
  }
  return [...tags];
};

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ReasonerRequestError) {
    if (error.apiError.code === 'RevisionConflict') {
      return '会话刚被其他 Agent 更新，已刷新最新版本后请重试。';
    }
    return error.apiError.message;
  }
  return error instanceof Error ? error.message : fallback;
};

/** Persistent session navigation and lifecycle management for the left edge of the workspace. */
export const SessionSidebar = (): ReactElement => {
  const [collapsed, setCollapsed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createGoalLabel, setCreateGoalLabel] = useState('');
  const [createAlias, setCreateAlias] = useState('');
  const [createTags, setCreateTags] = useState('');
  const [metadataAlias, setMetadataAlias] = useState('');
  const [metadataTags, setMetadataTags] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteIdCopied, setDeleteIdCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingSession, setEditingSession] = useState<ReasoningSession | null>(null);
  const [deletingSession, setDeletingSession] = useState<ReasoningSession | null>(null);
  const createDialogRef = useRef<HTMLDialogElement>(null);
  const metadataDialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const sessionId = useGraphStore((state) => state.sessionId);
  const setSessionId = useGraphStore((state) => state.setSessionId);
  const view = useGraphStore((state) => state.view);
  const sessions = useSessions();
  const currentSnapshotSession = view?.snapshot.session;
  const selectedSession =
    currentSnapshotSession?.sessionId === sessionId
      ? currentSnapshotSession
      : sessions.data?.sessions.find((item) => item.sessionId === sessionId);

  // A delete performed by another Agent should not leave the graph pane pinned
  // to a session that the next poll can no longer read.
  useEffect(() => {
    if (
      sessionId !== null &&
      sessions.isSuccess &&
      !sessions.isFetching &&
      !(sessions.data?.sessions ?? []).some((item) => item.sessionId === sessionId)
    ) {
      setSessionId(null);
    }
  }, [sessionId, sessions.data, sessions.isFetching, sessions.isSuccess, setSessionId]);

  useEffect(() => {
    const dialog = createDialogRef.current;
    if (dialog === null) return;
    if (createOpen && !dialog.open) dialog.showModal();
    if (!createOpen && dialog.open) dialog.close();
  }, [createOpen]);

  useEffect(() => {
    const dialog = metadataDialogRef.current;
    if (dialog === null) return;
    if (metadataOpen && !dialog.open) dialog.showModal();
    if (!metadataOpen && dialog.open) dialog.close();
  }, [metadataOpen]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (dialog === null) return;
    if (deleteOpen && !dialog.open) dialog.showModal();
    if (!deleteOpen && dialog.open) dialog.close();
  }, [deleteOpen]);

  const resetCreateForm = (): void => {
    setCreateGoalLabel('');
    setCreateAlias('');
    setCreateTags('');
    setCreateError(null);
  };

  const closeCreateDialog = (): void => {
    if (creating) return;
    setCreateOpen(false);
    resetCreateForm();
  };

  const openMetadataDialog = (): void => {
    if (selectedSession === undefined) return;
    setEditingSession(selectedSession);
    setMetadataAlias(selectedSession.alias ?? '');
    setMetadataTags(selectedSession.tags.join(', '));
    setMetadataError(null);
    setMetadataOpen(true);
  };

  const closeMetadataDialog = (): void => {
    if (savingMetadata) return;
    setMetadataOpen(false);
    setEditingSession(null);
    setMetadataError(null);
  };

  const openDeleteDialog = (): void => {
    if (selectedSession === undefined) return;
    setDeletingSession(selectedSession);
    setDeleteConfirmation('');
    setDeleteError(null);
    setDeleteIdCopied(false);
    setDeleteOpen(true);
  };

  const closeDeleteDialog = (): void => {
    if (deleting) return;
    setDeleteOpen(false);
    setDeletingSession(null);
    setDeleteConfirmation('');
    setDeleteError(null);
    setDeleteIdCopied(false);
  };

  const copyDeleteSessionId = async (): Promise<void> => {
    const target = deletingSession;
    if (target === null) return;
    if (navigator.clipboard === undefined) {
      setDeleteError('当前浏览器不支持自动复制，请手动复制上方会话 ID。');
      return;
    }
    try {
      await navigator.clipboard.writeText(target.sessionId);
      setDeleteIdCopied(true);
      setDeleteError(null);
    } catch {
      setDeleteError('复制会话 ID 失败，请手动复制上方会话 ID。');
    }
  };

  const refreshSessionQueries = async (targetSessionId?: string): Promise<void> => {
    const refreshes: Promise<unknown>[] = [
      queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    ];
    if (targetSessionId !== undefined) {
      refreshes.push(
        queryClient.invalidateQueries({ queryKey: ['reasoning-context', targetSessionId] }),
      );
    }
    await Promise.all(refreshes);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const goalLabel = createGoalLabel.trim();
    const alias = createAlias.trim();
    const tags = toTagList(createTags);
    if (goalLabel.length === 0) {
      setCreateError('请输入推理目标。');
      return;
    }
    if (tags.length > MAX_TAGS) {
      setCreateError(`最多可以设置 ${MAX_TAGS} 个标签。`);
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const created = await reasonerApi.createSession({
        goalLabel,
        tags,
        ...(alias.length === 0 ? {} : { alias }),
      });
      await refreshSessionQueries();
      setSessionId(created.session.sessionId);
      setCreateOpen(false);
      resetCreateForm();
    } catch (error) {
      setCreateError(errorMessage(error, '创建会话失败。'));
    } finally {
      setCreating(false);
    }
  };

  const handleMetadataSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = editingSession;
    if (target === null) return;
    const tags = toTagList(metadataTags);
    if (tags.length > MAX_TAGS) {
      setMetadataError(`最多可以设置 ${MAX_TAGS} 个标签。`);
      return;
    }

    setSavingMetadata(true);
    setMetadataError(null);
    try {
      await reasonerApi.updateSessionMetadata({
        sessionId: target.sessionId,
        baseGraphRevision: target.graphRevision,
        alias: metadataAlias.trim() || null,
        tags,
      });
      await refreshSessionQueries(target.sessionId);
      setMetadataOpen(false);
      setEditingSession(null);
    } catch (error) {
      await refreshSessionQueries(target.sessionId);
      setMetadataError(errorMessage(error, '保存会话信息失败。'));
    } finally {
      setSavingMetadata(false);
    }
  };

  const handleDelete = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = deletingSession;
    if (target === null) return;
    if (deleteConfirmation !== target.sessionId) {
      setDeleteError('请输入完整会话 ID 以确认删除。');
      return;
    }

    setDeleting(true);
    setDeleteError(null);
    try {
      await reasonerApi.deleteSession({
        sessionId: target.sessionId,
        baseGraphRevision: target.graphRevision,
      });
      queryClient.removeQueries({ queryKey: ['reasoning-context', target.sessionId] });
      if (sessionId === target.sessionId) setSessionId(null);
      await refreshSessionQueries();
      setDeleteOpen(false);
      setDeletingSession(null);
      setDeleteConfirmation('');
    } catch (error) {
      await refreshSessionQueries(target.sessionId);
      setDeleteError(errorMessage(error, '删除会话失败。'));
    } finally {
      setDeleting(false);
    }
  };

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
          <span aria-hidden="true">{collapsed ? '>' : '<'}</span>
        </button>
      </div>

      {!collapsed && (
        <div id="session-sidebar-content" className="session-sidebar-content">
          <section className="sidebar-section" aria-labelledby="session-list-heading">
            <div className="sidebar-section-heading">
              <h1 id="session-list-heading">会话管理</h1>
              <div className="sidebar-section-tools">
                {!sessions.isPending && (
                  <span className="muted small">{sessions.data?.sessions.length ?? 0}</span>
                )}
                <button
                  type="button"
                  className="sidebar-icon-button"
                  aria-label="新建会话"
                  title="新建会话"
                  onClick={() => {
                    resetCreateForm();
                    setCreateOpen(true);
                  }}
                >
                  +
                </button>
              </div>
            </div>

            <ul className="session-list" aria-label="推理会话列表">
              {sessions.isPending && <li className="sidebar-empty muted small">正在加载会话...</li>}
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
                      <span className="session-list-content">
                        <span
                          className={
                            item.alias === undefined
                              ? 'mono session-list-name'
                              : 'session-list-name'
                          }
                        >
                          {item.alias ?? item.sessionId}
                        </span>
                        {item.alias !== undefined && (
                          <span className="mono session-list-id">{item.sessionId}</span>
                        )}
                        {item.tags.length > 0 && (
                          <span
                            className="session-tag-list"
                            aria-label={`标签：${item.tags.join('、')}`}
                          >
                            {item.tags.map((tag) => (
                              <span key={tag} className="session-tag">
                                {tag}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
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
                <div className="sidebar-section-tools">
                  {selectedSession !== undefined && (
                    <>
                      <button
                        type="button"
                        className="sidebar-action"
                        title="编辑会话别名和标签"
                        onClick={openMetadataDialog}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="sidebar-action danger"
                        title="删除整个会话"
                        onClick={openDeleteDialog}
                      >
                        删除
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="sidebar-clear"
                    onClick={() => setSessionId(null)}
                    title="取消当前会话选择"
                  >
                    清除
                  </button>
                </div>
              )}
            </div>

            {selectedSession === undefined ? (
              <p className="sidebar-empty muted small">
                {sessionId === null
                  ? '选择会话后显示会话信息、图版本和事件游标。'
                  : '正在读取会话快照...'}
              </p>
            ) : (
              <dl className="sidebar-session-summary">
                <dt>别名</dt>
                <dd>{selectedSession.alias ?? '未设置'}</dd>
                <dt>标签</dt>
                <dd className="session-summary-tags">
                  {selectedSession.tags.length === 0 ? (
                    <span className="muted">未设置</span>
                  ) : (
                    <span className="session-tag-list">
                      {selectedSession.tags.map((tag) => (
                        <span key={tag} className="session-tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </dd>
                <dt>会话 ID</dt>
                <dd className="mono" title={selectedSession.sessionId}>
                  {selectedSession.sessionId}
                </dd>
                <dt>状态</dt>
                <dd className={`goal-${selectedSession.goalState}`}>{selectedSession.goalState}</dd>
                <dt>图版本</dt>
                <dd className="mono">r{selectedSession.graphRevision}</dd>
                <dt>事件</dt>
                <dd className="mono">#{selectedSession.lastEventSeq}</dd>
              </dl>
            )}
          </section>
        </div>
      )}

      <dialog
        ref={createDialogRef}
        className="detail-dialog session-dialog"
        aria-labelledby="create-session-heading"
        onClose={() => setCreateOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeCreateDialog();
        }}
      >
        <div className="detail-dialog-header">
          <h2 id="create-session-heading">新建推理会话</h2>
          <button
            type="button"
            className="detail-close"
            aria-label="关闭新建会话"
            onClick={closeCreateDialog}
          >
            ×
          </button>
        </div>
        <form className="session-form" onSubmit={(event) => void handleCreate(event)}>
          <label>
            推理目标
            <input
              value={createGoalLabel}
              maxLength={400}
              required
              disabled={creating}
              onChange={(event) => setCreateGoalLabel(event.target.value)}
            />
          </label>
          <label>
            会话别名
            <input
              value={createAlias}
              maxLength={120}
              disabled={creating}
              onChange={(event) => setCreateAlias(event.target.value)}
            />
          </label>
          <label>
            标签
            <input
              value={createTags}
              disabled={creating}
              onChange={(event) => setCreateTags(event.target.value)}
            />
          </label>
          {createError !== null && (
            <p className="form-error" role="alert">
              {createError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={closeCreateDialog} disabled={creating}>
              取消
            </button>
            <button type="submit" disabled={creating}>
              {creating ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={metadataDialogRef}
        className="detail-dialog session-dialog"
        aria-labelledby="edit-session-heading"
        onClose={() => setMetadataOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeMetadataDialog();
        }}
      >
        <div className="detail-dialog-header">
          <h2 id="edit-session-heading">编辑会话信息</h2>
          <button
            type="button"
            className="detail-close"
            aria-label="关闭会话编辑"
            onClick={closeMetadataDialog}
          >
            ×
          </button>
        </div>
        <form className="session-form" onSubmit={(event) => void handleMetadataSave(event)}>
          <label>
            会话别名
            <input
              value={metadataAlias}
              maxLength={120}
              disabled={savingMetadata}
              onChange={(event) => setMetadataAlias(event.target.value)}
            />
          </label>
          <label>
            标签
            <input
              value={metadataTags}
              disabled={savingMetadata}
              onChange={(event) => setMetadataTags(event.target.value)}
            />
          </label>
          {metadataError !== null && (
            <p className="form-error" role="alert">
              {metadataError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={closeMetadataDialog} disabled={savingMetadata}>
              取消
            </button>
            <button type="submit" disabled={savingMetadata}>
              {savingMetadata ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={deleteDialogRef}
        className="detail-dialog session-dialog"
        aria-labelledby="delete-session-heading"
        onClose={() => setDeleteOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDeleteDialog();
        }}
      >
        <div className="detail-dialog-header">
          <h2 id="delete-session-heading">删除推理会话</h2>
          <button
            type="button"
            className="detail-close"
            aria-label="关闭删除会话"
            onClick={closeDeleteDialog}
          >
            ×
          </button>
        </div>
        <form className="session-form" onSubmit={(event) => void handleDelete(event)}>
          <p className="delete-warning">
            将删除该会话的 SQLite 图、顶点、推理边、事件和上下文投影；已有 JSONL 审计日志会保留。
          </p>
          <div className="delete-session-id-block">
            <div className="delete-session-id-label">待删除的完整会话 ID</div>
            <div className="delete-session-id-row">
              <code className="delete-session-id-value">
                {deletingSession?.sessionId ?? '会话已失效，请关闭后重试'}
              </code>
              <button
                type="button"
                className="copy-session-id"
                onClick={() => void copyDeleteSessionId()}
                disabled={deleting || deletingSession === null}
              >
                {deleteIdCopied ? '已复制' : '复制 ID'}
              </button>
            </div>
            <p className="delete-session-id-hint">请将上面的完整 ID 粘贴到下方输入框进行确认。</p>
          </div>
          <label>
            确认会话 ID
            <input
              value={deleteConfirmation}
              disabled={deleting}
              autoComplete="off"
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
          </label>
          {deleteError !== null && (
            <p className="form-error" role="alert">
              {deleteError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={closeDeleteDialog} disabled={deleting}>
              取消
            </button>
            <button
              type="submit"
              className="danger-button"
              disabled={
                deleting ||
                deletingSession === null ||
                deleteConfirmation !== deletingSession.sessionId
              }
            >
              {deleting ? '删除中...' : '删除会话'}
            </button>
          </div>
        </form>
      </dialog>
    </aside>
  );
};

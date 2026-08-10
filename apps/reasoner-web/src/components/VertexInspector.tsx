import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGraphStore, type GraphScope } from '../state/graph-store.js';
import { ReasonerRequestError, reasonerApi } from '../api/client.js';
import { buildGraphAliases } from './graph-aliases.js';
import { buildIncomingInferenceFormulas } from './inference-formulas.js';

const SCOPE_OPTIONS: readonly { readonly id: GraphScope; readonly label: string }[] = [
  { id: 'All', label: '完整图' },
  { id: 'CurrentVertex', label: '当前节点' },
  { id: 'Dependencies', label: '到当前节点' },
];

const editorErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ReasonerRequestError) {
    if (error.apiError.code === 'RevisionConflict') {
      return '图刚被其他 Agent 更新，已刷新最新版本后请重试。';
    }
    return error.apiError.message;
  }
  return error instanceof Error ? error.message : fallback;
};

/** Vertex detail, including the opaque agent-supplied payload verbatim. */
export const VertexInspector = (): ReactElement => {
  const view = useGraphStore((state) => state.view);
  const selectedVertexId = useGraphStore((state) => state.selectedVertexId);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const graphScope = useGraphStore((state) => state.graphScope);
  const setGraphScope = useGraphStore((state) => state.setGraphScope);
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [editPayload, setEditPayload] = useState('{}');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setEditOpen(false);
    setEditError(null);
  }, [selectedVertexId]);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (dialog === null) return;
    if (editOpen && !dialog.open) dialog.showModal();
    if (!editOpen && dialog.open) dialog.close();
  }, [editOpen]);

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

  const openEditor = (): void => {
    setEditLabel(vertex.label);
    setEditPayload(JSON.stringify(vertex.payload, null, 2));
    setEditError(null);
    setEditOpen(true);
  };

  const closeEditor = (): void => {
    if (saving) return;
    setEditOpen(false);
    setEditError(null);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const label = editLabel.trim();
    if (label.length === 0) {
      setEditError('顶点标签不能为空。');
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(editPayload);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setEditError('载荷必须是 JSON 对象，例如 {}。');
        return;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      setEditError('载荷不是有效的 JSON。');
      return;
    }

    setSaving(true);
    setEditError(null);
    try {
      await reasonerApi.updateVertex({
        sessionId: view.snapshot.session.sessionId,
        vertexId: vertex.vertexId,
        baseGraphRevision: view.snapshot.graphRevision,
        label,
        payload,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['reasoning-context', view.snapshot.session.sessionId],
        }),
        queryClient.invalidateQueries({ queryKey: ['sessions'] }),
      ]);
      setEditOpen(false);
    } catch (error) {
      await queryClient.invalidateQueries({
        queryKey: ['reasoning-context', view.snapshot.session.sessionId],
      });
      setEditError(editorErrorMessage(error, '保存顶点失败。'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="vertex-heading">
      <div className="inspector-heading">
        <h2 id="vertex-heading">
          顶点 {vertexAlias}
          {isGoal ? '（目标）' : ''}
        </h2>
        <button type="button" className="detail-button" onClick={openEditor}>
          编辑
        </button>
      </div>
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
          <>
            <p className="muted small">
              {incomingFormulas.length === 1
                ? '该公式中的全部条件完成后，才能推出当前顶点。'
                : '每个公式组内的全部条件完成后成立；任一公式组成立即可推出当前顶点。'}
            </p>
            <ol className="inference-formula-list">
              {incomingFormulas.map((formula) => {
                const firstEdgeId = formula.edgeIds[0];
                const complete = formula.completedEdgeCount === formula.requiredEdgeCount;
                return (
                  <li key={formula.formulaId}>
                    <button
                      type="button"
                      className="inference-formula"
                      aria-label={`查看推理公式 ${formula.expression}`}
                      onClick={() => {
                        if (firstEdgeId !== undefined) selectEdge(firstEdgeId);
                      }}
                    >
                      <code>{formula.expression}</code>
                    </button>
                    <span className={`chip state-${complete ? 'Completed' : 'Candidate'}`}>
                      {complete
                        ? '条件已全部完成'
                        : `条件完成 ${formula.completedEdgeCount}/${formula.requiredEdgeCount}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
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
                {aliases.edgeById.get(edge.edgeId) ?? edge.edgeId} · {edge.label}
              </button>{' '}
              <span className={`chip state-${edge.state}`}>{edge.state}</span>
            </li>
          ))}
        </ul>
      )}

      <dialog
        ref={editDialogRef}
        className="detail-dialog session-dialog entity-edit-dialog"
        aria-labelledby="edit-vertex-heading"
        onClose={() => setEditOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}
      >
        <div className="detail-dialog-header">
          <h2 id="edit-vertex-heading">编辑顶点 {vertexAlias}</h2>
          <button
            type="button"
            className="detail-close"
            aria-label="关闭顶点编辑"
            onClick={closeEditor}
          >
            ×
          </button>
        </div>
        <form className="session-form" onSubmit={(event) => void handleSave(event)}>
          <p className="editor-note">
            Vn 索引、顶点类型和创建信息保持不变；这里只调整标签与 JSON 载荷。
          </p>
          <label>
            顶点标签
            <input
              value={editLabel}
              maxLength={400}
              required
              disabled={saving}
              onChange={(event) => setEditLabel(event.target.value)}
            />
          </label>
          <label>
            JSON 载荷
            <textarea
              className="editor-textarea"
              value={editPayload}
              rows={12}
              spellCheck={false}
              disabled={saving}
              onChange={(event) => setEditPayload(event.target.value)}
            />
          </label>
          {editError !== null && (
            <p className="form-error" role="alert">
              {editError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={closeEditor} disabled={saving}>
              取消
            </button>
            <button type="submit" disabled={saving}>
              {saving ? '保存中...' : '保存顶点'}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
};

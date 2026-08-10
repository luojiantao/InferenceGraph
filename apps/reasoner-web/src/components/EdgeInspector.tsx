import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InferenceEdgeQuestionInput, VertexId } from '@reasoner/schema';
import { ReasonerRequestError, reasonerApi } from '../api/client.js';
import { useGraphStore } from '../state/graph-store.js';
import { buildGraphAliases } from './graph-aliases.js';
import { buildIncomingInferenceFormulas } from './inference-formulas.js';

const STATE_LABELS: Record<string, string> = {
  Candidate: '候选',
  Leased: '已领取',
  Completed: '已完成',
  Blocked: '已阻塞',
  Abandoned: '已放弃',
  Invalid: '结构无效',
};

const editorErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ReasonerRequestError) {
    if (error.apiError.code === 'RevisionConflict') {
      return '图刚被其他 Agent 更新，已刷新最新版本后请重试。';
    }
    return error.apiError.message;
  }
  return error instanceof Error ? error.message : fallback;
};

const normalizeQuestionPrompt = (prompt: string): string =>
  prompt.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Edge detail with its evidence questions rendered as edge attributes. Questions
 * are never promoted to vertices or edges of their own.
 */
export const EdgeInspector = (): ReactElement => {
  const view = useGraphStore((state) => state.view);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectedArcId = useGraphStore((state) => state.selectedArcId);
  const selectVertex = useGraphStore((state) => state.selectVertex);
  const queryClient = useQueryClient();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [editCost, setEditCost] = useState('1');
  const [editPriority, setEditPriority] = useState('0');
  const [editQuestions, setEditQuestions] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const detailsDialogRef = useRef<HTMLDialogElement>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setDetailsOpen(false);
    setEditOpen(false);
    setEditError(null);
  }, [selectedEdgeId]);

  useEffect(() => {
    const dialog = detailsDialogRef.current;
    if (dialog === null) return;
    if (detailsOpen && !dialog.open) dialog.showModal();
    if (!detailsOpen && dialog.open) dialog.close();
  }, [detailsOpen]);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (dialog === null) return;
    if (editOpen && !dialog.open) dialog.showModal();
    if (!editOpen && dialog.open) dialog.close();
  }, [editOpen]);

  if (view === null) return <p className="muted">尚未加载会话。</p>;
  if (selectedEdgeId === null) {
    return <p className="muted">在画布或前沿中选择一条推理边以查看详情。</p>;
  }

  const edge = view.snapshot.edges.find((candidate) => candidate.edgeId === selectedEdgeId);
  if (edge === undefined) {
    return <p className="muted">这条边已不在当前快照中。</p>;
  }

  const aliases = buildGraphAliases(view.snapshot);
  const edgeAlias =
    (selectedArcId === null ? undefined : aliases.arcById.get(selectedArcId)) ??
    aliases.edgeById.get(edge.edgeId) ??
    edge.edgeId;
  const vertexLabel = (vertexId: VertexId): string =>
    `${aliases.vertexById.get(vertexId) ?? vertexId} · ${
      view.snapshot.vertices.find((vertex) => vertex.vertexId === vertexId)?.label ?? vertexId
    }`;
  const targetVertexId = edge.targetVertexIds[0];
  const formula =
    targetVertexId === undefined
      ? undefined
      : buildIncomingInferenceFormulas(view.snapshot, targetVertexId).find((candidate) =>
          candidate.edgeIds.includes(edge.edgeId),
        );
  const formulaComplete =
    formula !== undefined && formula.completedEdgeCount === formula.requiredEdgeCount;
  const canEdit = edge.state !== 'Leased';
  const canEditQuestions = edge.state === 'Candidate';

  const openEditor = (): void => {
    setEditLabel(edge.label);
    setEditCost(String(edge.cost));
    setEditPriority(String(edge.priority));
    setEditQuestions(edge.evidenceQuestions.map((question) => question.prompt).join('\n'));
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
      setEditError('边描述不能为空。');
      return;
    }
    const cost = Number(editCost);
    const priority = Number(editPriority);
    if (!Number.isFinite(cost) || cost < 0) {
      setEditError('成本必须是大于等于 0 的有限数字。');
      return;
    }
    if (!Number.isFinite(priority)) {
      setEditError('优先级必须是有限数字。');
      return;
    }

    let evidenceQuestions: readonly InferenceEdgeQuestionInput[] | undefined;
    if (canEditQuestions) {
      const existingByPrompt = new Map(
        edge.evidenceQuestions.map((question) => [
          normalizeQuestionPrompt(question.prompt),
          question,
        ]),
      );
      const seen = new Set<string>();
      const questions: InferenceEdgeQuestionInput[] = [];
      for (const rawPrompt of editQuestions.split(/\r?\n/)) {
        const prompt = rawPrompt.trim();
        if (prompt.length === 0) continue;
        const normalized = normalizeQuestionPrompt(prompt);
        if (seen.has(normalized)) {
          setEditError('取证问题不能重复。');
          return;
        }
        seen.add(normalized);
        const existing = existingByPrompt.get(normalized);
        questions.push(
          existing === undefined ? { prompt } : { questionId: existing.questionId, prompt },
        );
      }
      evidenceQuestions = questions;
    }

    const input: {
      readonly label: string;
      readonly cost: number;
      readonly priority: number;
      readonly evidenceQuestions?: readonly InferenceEdgeQuestionInput[];
    } = {
      label,
      cost,
      priority,
      ...(evidenceQuestions === undefined ? {} : { evidenceQuestions }),
    };

    setSaving(true);
    setEditError(null);
    try {
      await reasonerApi.updateInferenceEdge({
        sessionId: view.snapshot.session.sessionId,
        edgeId: edge.edgeId,
        baseGraphRevision: view.snapshot.graphRevision,
        ...input,
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
      setEditError(editorErrorMessage(error, '保存推理边失败。'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="edge-heading">
      <div className="inspector-heading">
        <h2 id="edge-heading">推理边 {edgeAlias}</h2>
        <button
          type="button"
          className="detail-button"
          title={canEdit ? '编辑推理边' : '租约中的边不能编辑，请先释放租约'}
          disabled={!canEdit}
          onClick={openEditor}
        >
          编辑
        </button>
      </div>

      <div className="edge-primary">
        <p className="edge-description">{edge.label}</p>
        <button type="button" className="detail-button" onClick={() => setDetailsOpen(true)}>
          详情
        </button>
      </div>

      {formula !== undefined && (
        <div className="vertex-reasoning">
          <h3>所属节点公式</h3>
          <code className="formula-expression">{formula.expression}</code>
          <p className="muted small">
            {formula.requiredEdgeCount === 1
              ? '该边完成后即可满足此公式。'
              : formulaComplete
                ? '该公式的全部条件已完成。'
                : `该公式要求全部 ${formula.requiredEdgeCount} 个条件完成；当前 ${formula.completedEdgeCount}/${formula.requiredEdgeCount}。`}
          </p>
        </div>
      )}

      <div className="edge-evidence">
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
      </div>

      <dialog
        ref={detailsDialogRef}
        className="detail-dialog"
        aria-labelledby="edge-details-heading"
        onClose={() => setDetailsOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setDetailsOpen(false);
        }}
      >
        <div className="detail-dialog-header">
          <h2 id="edge-details-heading">推理边 {edgeAlias} 详情</h2>
          <button
            type="button"
            className="detail-close"
            aria-label="关闭详情"
            onClick={() => setDetailsOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="detail-dialog-body">
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

          <h3>来源顶点</h3>
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
        </div>
      </dialog>

      <dialog
        ref={editDialogRef}
        className="detail-dialog session-dialog entity-edit-dialog"
        aria-labelledby="edit-edge-heading"
        onClose={() => setEditOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}
      >
        <div className="detail-dialog-header">
          <h2 id="edit-edge-heading">编辑推理边 {edgeAlias}</h2>
          <button
            type="button"
            className="detail-close"
            aria-label="关闭推理边编辑"
            onClick={closeEditor}
          >
            ×
          </button>
        </div>
        <form className="session-form" onSubmit={(event) => void handleSave(event)}>
          <p className="editor-note">
            En
            索引、来源/目标顶点、公式组和边状态保持不变；这里只调整描述、调度参数和候选边取证问题。
          </p>
          <label>
            边描述
            <input
              value={editLabel}
              maxLength={400}
              required
              disabled={saving}
              onChange={(event) => setEditLabel(event.target.value)}
            />
          </label>
          <div className="editor-field-grid">
            <label>
              成本
              <input
                type="number"
                min="0"
                step="any"
                value={editCost}
                disabled={saving}
                onChange={(event) => setEditCost(event.target.value)}
              />
            </label>
            <label>
              优先级
              <input
                type="number"
                step="any"
                value={editPriority}
                disabled={saving}
                onChange={(event) => setEditPriority(event.target.value)}
              />
            </label>
          </div>
          <label>
            候选边取证问题
            <textarea
              className="editor-textarea"
              value={editQuestions}
              rows={7}
              disabled={saving || !canEditQuestions}
              placeholder="每行一个问题"
              onChange={(event) => setEditQuestions(event.target.value)}
            />
          </label>
          {!canEditQuestions && (
            <p className="editor-note">
              只有候选状态的边可以调整取证问题；已完成或已阻塞的问题记录保持不变。
            </p>
          )}
          {edge.state === 'Leased' && (
            <p className="form-error" role="alert">
              当前边有活动租约，请先由持有 Agent 释放租约后再编辑。
            </p>
          )}
          {editError !== null && (
            <p className="form-error" role="alert">
              {editError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={closeEditor} disabled={saving}>
              取消
            </button>
            <button type="submit" disabled={saving || !canEdit}>
              {saving ? '保存中...' : '保存推理边'}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
};

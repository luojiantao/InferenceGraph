import type { ReactElement } from 'react';
import { useGraphStore } from '../state/graph-store.js';

/**
 * Immutable audit trail ordered by eventSeq. Gap detection is also keyed on
 * eventSeq, because one revision can emit several events and a revision-keyed
 * cursor would silently drop all but the last.
 */
export const EventTimeline = (): ReactElement => {
  const events = useGraphStore((state) => state.events);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const selectVertex = useGraphStore((state) => state.selectVertex);

  if (events.length === 0) {
    return <p className="muted">还没有事件。</p>;
  }

  const ordered = [...events].reverse();
  const gaps: number[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (previous !== undefined && current !== undefined && current.eventSeq !== previous.eventSeq + 1) {
      gaps.push(previous.eventSeq);
    }
  }

  return (
    <section className="panel" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">
        事件时间线 <span className="badge">{events.length}</span>
      </h2>

      {gaps.length > 0 && (
        <p className="warn small" role="status">
          检测到 {gaps.length} 处事件序号缺口（上次连续到 #{gaps[gaps.length - 1]}）。可能有事件页尚未拉取。
        </p>
      )}

      <ol className="timeline">
        {ordered.map((event) => {
          const { edgeId, vertexId } = event;
          return (
            <li key={event.eventSeq}>
              <span className="seq mono">#{event.eventSeq}</span>
              <span className="row-main">
                <span className="row-title">{event.kind}</span>
                <span className="muted small">
                  r{event.graphRevision} · {event.actorAgentId} · {event.occurredAt}
                </span>
                {(edgeId !== undefined || vertexId !== undefined) && (
                  <span className="small">
                    {edgeId !== undefined && (
                      <button type="button" className="link" onClick={() => selectEdge(edgeId)}>
                        边
                      </button>
                    )}
                    {vertexId !== undefined && (
                      <button type="button" className="link" onClick={() => selectVertex(vertexId)}>
                        顶点
                      </button>
                    )}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

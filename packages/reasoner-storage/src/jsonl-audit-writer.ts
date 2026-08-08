import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ok, err, type GraphEvent, type Result, type SessionId } from '@reasoner/schema';
import type { AuditWriter } from '@reasoner/core';

/**
 * Append-only JSONL mirror of committed events, one file per session.
 *
 * This is a secondary record, not the transactional store: a failure here is
 * reported but never rolls back the committed SQLite transaction. Writes are
 * serialised per session so lines cannot interleave.
 */
export class JsonlAuditWriter implements AuditWriter {
  private readonly queues = new Map<SessionId, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async append(sessionId: SessionId, events: readonly GraphEvent[]): Promise<Result<void>> {
    if (events.length === 0) return ok(undefined);

    const path = join(this.rootDir, 'audit', `${sessionId}.jsonl`);
    const payload = events.map((event) => JSON.stringify(event)).join('\n') + '\n';

    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let settle: () => void = () => {};
    this.queues.set(
      sessionId,
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    try {
      await previous;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, payload, 'utf8');
      return ok(undefined);
    } catch (cause) {
      return err('StorageFailure', `audit append failed: ${String(cause)}`, {
        sessionId,
        path,
      });
    } finally {
      settle();
    }
  }
}

/** Audit writer used by tests and by runs that intentionally keep no JSONL log. */
export class NullAuditWriter implements AuditWriter {
  async append(): Promise<Result<void>> {
    return ok(undefined);
  }
}

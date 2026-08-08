import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '@reasoner/core';
import { NULL_LOGGER, type IsoTimestamp, type Logger } from '@reasoner/schema';
import { SqliteReasonerRepository } from './sqlite-reasoner-repository.js';
import { JsonlAuditWriter, NullAuditWriter } from './jsonl-audit-writer.js';

export const systemClock: Clock = {
  now: (): IsoTimestamp => new Date().toISOString(),
};

export const uuidIdGenerator: IdGenerator = {
  newId: (prefix: string): string => `${prefix}-${randomUUID()}`,
};

export interface StorageOptions {
  /** Directory for the SQLite file and audit logs, or ':memory:' for tests. */
  readonly dataDir: string;
  readonly clock?: Clock;
  readonly enableAudit?: boolean;
  /** Optional sink for storage diagnostics. Silent when omitted. */
  readonly logger?: Logger;
}

export interface StorageRuntime {
  readonly repository: SqliteReasonerRepository;
  readonly audit: JsonlAuditWriter | NullAuditWriter;
  readonly db: DatabaseSync;
  close(): void;
}

const migrationSql = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Resolves for both dist/ and src/ layouts.
  for (const candidate of [
    join(here, '..', 'migrations', '0000_initial.sql'),
    join(here, '..', '..', 'migrations', '0000_initial.sql'),
  ]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error('could not locate migrations/0000_initial.sql');
};

/** Applies the schema. Idempotent: every statement is IF NOT EXISTS. */
export const migrateStorage = (db: DatabaseSync): void => {
  db.exec(migrationSql());
};

export const createStorage = (options: StorageOptions): StorageRuntime => {
  const log = (options.logger ?? NULL_LOGGER).child({ component: 'storage' });
  const inMemory = options.dataDir === ':memory:';
  if (!inMemory) mkdirSync(options.dataDir, { recursive: true });

  const dbPath = inMemory ? ':memory:' : join(options.dataDir, 'reasoner.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  // Wait rather than fail immediately when another writer holds the lock.
  db.exec('PRAGMA busy_timeout = 5000');
  migrateStorage(db);

  const clock = options.clock ?? systemClock;
  const auditEnabled = !(options.enableAudit === false || inMemory);
  const audit = auditEnabled ? new JsonlAuditWriter(options.dataDir) : new NullAuditWriter();

  log.info({ dbPath, auditEnabled }, 'storage opened');

  return {
    repository: new SqliteReasonerRepository(db, clock, log),
    audit,
    db,
    close: (): void => {
      db.close();
      log.info({ dbPath }, 'storage closed');
    },
  };
};

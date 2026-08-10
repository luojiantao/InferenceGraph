import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  expandedEdgeDedupeKey,
  inferenceFormulaId,
  type Clock,
  type IdGenerator,
} from '@reasoner/core';
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

type ReferenceRow = Record<string, unknown>;

interface LegacyEdgePair {
  readonly sourceVertexId: string;
  readonly targetVertexId: string;
}

interface SplitEdgePlan {
  readonly edgeId: string;
  readonly originalEdgeId: string;
  readonly formulaId: string;
  readonly sourceVertexId: string;
  readonly targetVertexId: string;
  readonly state: string;
  readonly dedupeKey: string | null;
  readonly isOriginal: boolean;
  readonly row: ReferenceRow;
}

const hasColumn = (
  db: DatabaseSync,
  table: 'vertices' | 'inference_edges',
  column: string,
): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as ReferenceRow[]).some(
    (row) => row['name'] === column,
  );

const referenceOrdinal = (value: unknown, prefix: 'V' | 'E'): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = new RegExp(`^${prefix}([1-9][0-9]*)$`).exec(value);
  if (match === null) return undefined;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value));

const asOptionalString = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : asString(value);

const migratedFormulaId = (
  sourceVertexIds: readonly string[],
  targetVertexId: string,
  label: string,
  originalEdgeId: string,
): string =>
  inferenceFormulaId(sourceVertexIds, targetVertexId, label, `migration:${originalEdgeId}`);

const listEndpointIds = (
  db: DatabaseSync,
  table: 'edge_sources' | 'edge_targets',
  sessionId: string,
  edgeId: string,
): readonly string[] =>
  (
    db
      .prepare(
        `SELECT vertex_id FROM ${table}
         WHERE session_id = ? AND edge_id = ?
         ORDER BY ordinal, vertex_id`,
      )
      .all(sessionId, edgeId) as ReferenceRow[]
  ).map((row) => asString(row['vertex_id']));

const migratedEdgeId = (originalEdgeId: string, pairIndex: number, used: ReadonlySet<string>): string => {
  let attempt = 0;
  for (;;) {
    const suffix = `:split:${pairIndex + 1}${attempt === 0 ? '' : `:${attempt}`}`;
    const base = (originalEdgeId || 'legacy-edge').slice(0, Math.max(1, 200 - suffix.length));
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
    attempt += 1;
  }
};

const migrationDedupeKey = (
  originalEdgeId: string,
  pairIndex: number,
  attempt: number,
): string => {
  const suffix = `:split:${pairIndex + 1}${attempt === 0 ? '' : `:${attempt}`}`;
  return `m:${(originalEdgeId || 'legacy-edge').slice(0, Math.max(1, 400 - 2 - suffix.length))}${suffix}`;
};

const reserveDedupeKey = (
  candidate: string,
  used: Set<string>,
  originalEdgeId: string,
  pairIndex: number,
): string => {
  let value = candidate.length <= 400 ? candidate : migrationDedupeKey(originalEdgeId, pairIndex, 0);
  let attempt = 0;
  while (used.has(value)) {
    attempt += 1;
    value = migrationDedupeKey(originalEdgeId, pairIndex, attempt);
  }
  used.add(value);
  return value;
};

/**
 * Converts the former many-to-many edge rows into independent binary edges.
 * The first source/target pair retains the original internal id; later pairs
 * receive deterministic migration ids. All En references are then reassigned
 * in original edge and endpoint order, which makes the conversion stable.
 */
const splitLegacyInferenceEdges = (db: DatabaseSync): void => {
  const sessions = db
    .prepare('SELECT DISTINCT session_id FROM inference_edges ORDER BY session_id')
    .all() as ReferenceRow[];

  const selectEdges = db.prepare(
    `SELECT * FROM inference_edges
     WHERE session_id = ?
     ORDER BY created_at_revision, edge_id`,
  );
  const selectQuestions = db.prepare(
    `SELECT * FROM evidence_questions
     WHERE session_id = ? AND edge_id = ?
     ORDER BY ordinal, question_id`,
  );
  const updateReferenceId = db.prepare(
    'UPDATE inference_edges SET reference_id = ? WHERE session_id = ? AND edge_id = ?',
  );
  const updateOriginal = db.prepare(
    `UPDATE inference_edges
     SET state = ?, dedupe_key = ?, formula_id = ?
     WHERE session_id = ? AND edge_id = ?`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO inference_edges (
       session_id, edge_id, reference_id, formula_id, label, state, cost, priority, conclusion,
       blocked_reason, dedupe_key, proposed_by_agent, created_at, created_at_revision,
       updated_at_revision
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const deleteSources = db.prepare('DELETE FROM edge_sources WHERE session_id = ? AND edge_id = ?');
  const deleteTargets = db.prepare('DELETE FROM edge_targets WHERE session_id = ? AND edge_id = ?');
  const insertSource = db.prepare(
    'INSERT INTO edge_sources (session_id, edge_id, vertex_id, ordinal) VALUES (?,?,?,0)',
  );
  const insertTarget = db.prepare(
    'INSERT INTO edge_targets (session_id, edge_id, vertex_id, ordinal) VALUES (?,?,?,0)',
  );
  const insertQuestion = db.prepare(
    `INSERT INTO evidence_questions (
       session_id, edge_id, question_id, prompt, normalized_prompt,
       answer, answered_by_agent, answered_at, answered_at_revision, ordinal
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const sessionRow of sessions) {
    const sessionId = asString(sessionRow['session_id']);
    const rows = selectEdges.all(sessionId) as ReferenceRow[];
    const usedEdgeIds = new Set(rows.map((row) => asString(row['edge_id'])));
    const usedDedupeKeys = new Set(
      rows
        .map((row) => asOptionalString(row['dedupe_key']))
        .filter((dedupeKey): dedupeKey is string => dedupeKey !== undefined),
    );
    const plans: SplitEdgePlan[] = [];
    const splitOriginalEdgeIds = new Set<string>();

    for (const row of rows) {
      const originalEdgeId = asString(row['edge_id']);
      const sources = listEndpointIds(db, 'edge_sources', sessionId, originalEdgeId);
      const targets = listEndpointIds(db, 'edge_targets', sessionId, originalEdgeId);
      if (sources.length === 0 || targets.length === 0 || (sources.length === 1 && targets.length === 1)) {
        plans.push({
          edgeId: originalEdgeId,
          originalEdgeId,
          formulaId:
            asOptionalString(row['formula_id']) ??
            migratedFormulaId(sources, targets[0] ?? '', asString(row['label']), originalEdgeId),
          sourceVertexId: sources[0] ?? '',
          targetVertexId: targets[0] ?? '',
          state: asString(row['state']),
          dedupeKey: asOptionalString(row['dedupe_key']) ?? null,
          isOriginal: true,
          row,
        });
        continue;
      }

      splitOriginalEdgeIds.add(originalEdgeId);
      const pairs: LegacyEdgePair[] = [];
      for (const sourceVertexId of sources) {
        for (const targetVertexId of targets) pairs.push({ sourceVertexId, targetVertexId });
      }
      const legacyDedupeKey = asOptionalString(row['dedupe_key']);
      const explicitDedupeKey =
        legacyDedupeKey !== undefined && legacyDedupeKey.startsWith('k:')
          ? legacyDedupeKey.slice(2)
          : undefined;

      for (const [pairIndex, pair] of pairs.entries()) {
        const edgeId =
          pairIndex === 0
            ? originalEdgeId
            : migratedEdgeId(originalEdgeId, pairIndex, usedEdgeIds);
        usedEdgeIds.add(edgeId);
        const dedupeKey = reserveDedupeKey(
          expandedEdgeDedupeKey(
            pair.sourceVertexId,
            pair.targetVertexId,
            asString(row['label']),
            explicitDedupeKey,
            true,
          ),
          usedDedupeKeys,
          originalEdgeId,
          pairIndex,
        );
        plans.push({
          edgeId,
          originalEdgeId,
          formulaId: migratedFormulaId(
            sources,
            pair.targetVertexId,
            asString(row['label']),
            originalEdgeId,
          ),
          sourceVertexId: pair.sourceVertexId,
          targetVertexId: pair.targetVertexId,
          state:
            pairIndex === 0 || asString(row['state']) !== 'Leased'
              ? asString(row['state'])
              : 'Candidate',
          dedupeKey,
          isOriginal: pairIndex === 0,
          row,
        });
      }
    }

    if (splitOriginalEdgeIds.size === 0) continue;

    const questionsByOriginalEdgeId = new Map<string, readonly ReferenceRow[]>();
    for (const originalEdgeId of splitOriginalEdgeIds) {
      questionsByOriginalEdgeId.set(
        originalEdgeId,
        selectQuestions.all(sessionId, originalEdgeId) as ReferenceRow[],
      );
    }

    // Move every existing reference out of the En namespace before assigning E1..En again.
    for (const row of rows) {
      const edgeId = asString(row['edge_id']);
      updateReferenceId.run(`migration:${edgeId}`, sessionId, edgeId);
    }

    for (const originalEdgeId of splitOriginalEdgeIds) {
      deleteSources.run(sessionId, originalEdgeId);
      deleteTargets.run(sessionId, originalEdgeId);
    }

    for (const plan of plans) {
      if (splitOriginalEdgeIds.has(plan.originalEdgeId)) {
        if (plan.isOriginal) {
          updateOriginal.run(plan.state, plan.dedupeKey, plan.formulaId, sessionId, plan.edgeId);
        } else {
          const row = plan.row;
          insertEdge.run(
            sessionId,
            plan.edgeId,
            `migration:${plan.edgeId}`,
            plan.formulaId,
            asString(row['label']),
            plan.state,
            Number(row['cost']),
            Number(row['priority']),
            asOptionalString(row['conclusion']) ?? null,
            asOptionalString(row['blocked_reason']) ?? null,
            plan.dedupeKey,
            asString(row['proposed_by_agent']),
            asString(row['created_at']),
            Number(row['created_at_revision']),
            Number(row['updated_at_revision']),
          );
          for (const question of questionsByOriginalEdgeId.get(plan.originalEdgeId) ?? []) {
            insertQuestion.run(
              sessionId,
              plan.edgeId,
              asString(question['question_id']),
              asString(question['prompt']),
              asString(question['normalized_prompt']),
              asOptionalString(question['answer']) ?? null,
              asOptionalString(question['answered_by_agent']) ?? null,
              asOptionalString(question['answered_at']) ?? null,
              question['answered_at_revision'] === null ||
              question['answered_at_revision'] === undefined
                ? null
                : Number(question['answered_at_revision']),
              Number(question['ordinal']),
            );
          }
        }
        insertSource.run(sessionId, plan.edgeId, plan.sourceVertexId);
        insertTarget.run(sessionId, plan.edgeId, plan.targetVertexId);
      }
    }

    plans.forEach((plan, index) => {
      updateReferenceId.run(`E${index + 1}`, sessionId, plan.edgeId);
    });
  }
};

const splitBaseEdgeId = (edgeId: string): string | undefined => {
  const match = /^(.*):split:[1-9][0-9]*(?::[1-9][0-9]*)?$/.exec(edgeId);
  return match?.[1];
};

/**
 * Adds a formula id to databases written before independent arrows retained
 * their original AND grouping. Existing split siblings are reunited by their
 * migration base id and target, never by a rendered or synthetic node.
 */
const migrateFormulaIds = (db: DatabaseSync): void => {
  if (!hasColumn(db, 'inference_edges', 'formula_id')) {
    db.exec('ALTER TABLE inference_edges ADD COLUMN formula_id TEXT');
  }

  const sessions = db
    .prepare('SELECT DISTINCT session_id FROM inference_edges ORDER BY session_id')
    .all() as ReferenceRow[];
  const selectEdges = db.prepare(
    `SELECT edge_id, formula_id, label, created_at_revision
     FROM inference_edges
     WHERE session_id = ?
     ORDER BY created_at_revision, edge_id`,
  );
  const updateFormulaId = db.prepare(
    'UPDATE inference_edges SET formula_id = ? WHERE session_id = ? AND edge_id = ?',
  );

  for (const sessionRow of sessions) {
    const sessionId = asString(sessionRow['session_id']);
    const rows = selectEdges.all(sessionId) as ReferenceRow[];
    const ids = new Set(rows.map((row) => asString(row['edge_id'])));
    const splitBases = new Set(
      rows
        .map((row) => splitBaseEdgeId(asString(row['edge_id'])))
        .filter((base): base is string => base !== undefined && ids.has(base)),
    );
    const buckets = new Map<
      string,
      {
        readonly edgeId: string;
        readonly formulaId: string | undefined;
        readonly label: string;
        readonly sourceVertexId: string;
        readonly targetVertexId: string;
        readonly baseId: string;
      }[]
    >();

    for (const row of rows) {
      const edgeId = asString(row['edge_id']);
      const sourceVertexId = listEndpointIds(db, 'edge_sources', sessionId, edgeId)[0] ?? '';
      const targetVertexId = listEndpointIds(db, 'edge_targets', sessionId, edgeId)[0] ?? '';
      const splitBase = splitBaseEdgeId(edgeId);
      const baseId =
        splitBase !== undefined && splitBases.has(splitBase)
          ? splitBase
          : splitBases.has(edgeId)
            ? edgeId
            : edgeId;
      const label = asString(row['label']);
      const key = `${baseId}\u0000${targetVertexId}\u0000${label}\u0000${asString(
        row['created_at_revision'],
      )}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push({
        edgeId,
        formulaId: asOptionalString(row['formula_id']),
        label,
        sourceVertexId,
        targetVertexId,
        baseId,
      });
      buckets.set(key, bucket);
    }

    for (const bucket of buckets.values()) {
      const existing = [...new Set(bucket.flatMap((entry) => (entry.formulaId === undefined ? [] : [entry.formulaId])))];
      const first = bucket[0];
      if (first === undefined) continue;
      const formulaId =
        existing.length === 1
          ? (existing[0] ??
            migratedFormulaId(
              bucket.map((entry) => entry.sourceVertexId),
              first.targetVertexId,
              first.label,
              first.baseId,
            ))
          : migratedFormulaId(
              bucket.map((entry) => entry.sourceVertexId),
              first.targetVertexId,
              first.label,
              first.baseId,
            );
      for (const entry of bucket) {
        if (entry.formulaId !== formulaId) updateFormulaId.run(formulaId, sessionId, entry.edgeId);
      }
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS ix_edges_formula_id ON inference_edges (session_id, formula_id)');
};

const backfillReferenceIds = (
  db: DatabaseSync,
  table: 'vertices' | 'inference_edges',
  entityIdColumn: 'vertex_id' | 'edge_id',
  prefix: 'V' | 'E',
): void => {
  const rows = db
    .prepare(
      `SELECT session_id, ${entityIdColumn} AS entity_id, reference_id, created_at_revision
       FROM ${table}
       ORDER BY session_id, created_at_revision, ${entityIdColumn}`,
    )
    .all() as ReferenceRow[];
  const usedOrdinals = new Map<string, Set<number>>();
  const update = db.prepare(
    `UPDATE ${table} SET reference_id = ? WHERE session_id = ? AND ${entityIdColumn} = ?`,
  );

  for (const row of rows) {
    const sessionId = String(row['session_id']);
    const entityId = String(row['entity_id']);
    const used = usedOrdinals.get(sessionId) ?? new Set<number>();
    usedOrdinals.set(sessionId, used);

    const existingOrdinal = referenceOrdinal(row['reference_id'], prefix);
    let ordinal = existingOrdinal;
    if (ordinal === undefined || used.has(ordinal)) {
      ordinal = 1;
      while (used.has(ordinal)) ordinal += 1;
    }
    used.add(ordinal);

    const referenceId = `${prefix}${ordinal}`;
    if (row['reference_id'] !== referenceId) update.run(referenceId, sessionId, entityId);
  }
};

/** Adds and backfills immutable Vn/En references for databases created before this field existed. */
const migrateReferenceIds = (db: DatabaseSync): void => {
  if (!hasColumn(db, 'vertices', 'reference_id')) {
    db.exec('ALTER TABLE vertices ADD COLUMN reference_id TEXT');
  }
  if (!hasColumn(db, 'inference_edges', 'reference_id')) {
    db.exec('ALTER TABLE inference_edges ADD COLUMN reference_id TEXT');
  }

  backfillReferenceIds(db, 'vertices', 'vertex_id', 'V');
  backfillReferenceIds(db, 'inference_edges', 'edge_id', 'E');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_vertices_reference_id ON vertices (session_id, reference_id)',
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_edges_reference_id ON inference_edges (session_id, reference_id)',
  );
};

/** Applies the schema and compatibility migrations. */
export const migrateStorage = (db: DatabaseSync): void => {
  db.exec(migrationSql());
  db.exec('BEGIN IMMEDIATE');
  try {
    migrateReferenceIds(db);
    // The splitter writes formula_id, so make the column available first.
    migrateFormulaIds(db);
    splitLegacyInferenceEdges(db);
    // Existing split rows from the previous release need their AND group backfilled.
    migrateFormulaIds(db);
    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original migration error is more useful than a failed cleanup.
    }
    throw cause;
  }
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

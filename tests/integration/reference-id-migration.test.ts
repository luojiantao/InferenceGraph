import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateStorage } from '@reasoner/storage';

const temporaryDirectories: string[] = [];

const createLegacyDatabase = (): { readonly directory: string; readonly db: DatabaseSync } => {
  const directory = mkdtempSync(join(tmpdir(), 'reasoner-reference-migration-'));
  temporaryDirectories.push(directory);
  const db = new DatabaseSync(join(directory, 'reasoner.db'));
  db.exec(`
    CREATE TABLE reasoning_sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE vertices (
      session_id TEXT NOT NULL,
      vertex_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      created_by_agent TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_revision INTEGER NOT NULL,
      PRIMARY KEY (session_id, vertex_id)
    );
    CREATE TABLE inference_edges (
      session_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      label TEXT NOT NULL,
      state TEXT NOT NULL,
      cost REAL NOT NULL,
      priority REAL NOT NULL,
      conclusion TEXT,
      blocked_reason TEXT,
      dedupe_key TEXT,
      proposed_by_agent TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_revision INTEGER NOT NULL,
      updated_at_revision INTEGER NOT NULL,
      PRIMARY KEY (session_id, edge_id)
    );
  `);
  return { directory, db };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // SQLite can retain a WAL handle briefly on Windows after close().
    }
  }
});

describe('storage: persisted reference ids', () => {
  it('backfills pre-reference databases once in creation order', () => {
    const { db } = createLegacyDatabase();
    const sessionId = 'legacy-session';
    const timestamp = '2026-01-01T00:00:00.000Z';
    const addVertex = db.prepare(
      `INSERT INTO vertices (
         session_id, vertex_id, kind, label, payload_json, dedupe_key,
         created_by_agent, created_at, created_at_revision
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    addVertex.run(sessionId, 'vertex-b', 'State', 'B', '{}', null, 'agent', timestamp, 2);
    addVertex.run(sessionId, 'vertex-a', 'State', 'A', '{}', null, 'agent', timestamp, 1);

    const addEdge = db.prepare(
      `INSERT INTO inference_edges (
         session_id, edge_id, label, state, cost, priority, conclusion, blocked_reason,
         dedupe_key, proposed_by_agent, created_at, created_at_revision, updated_at_revision
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    addEdge.run(
      sessionId,
      'edge-b',
      'B',
      'Candidate',
      1,
      0,
      null,
      null,
      null,
      'agent',
      timestamp,
      2,
      2,
    );
    addEdge.run(
      sessionId,
      'edge-a',
      'A',
      'Candidate',
      1,
      0,
      null,
      null,
      null,
      'agent',
      timestamp,
      1,
      1,
    );

    migrateStorage(db);
    migrateStorage(db);

    expect(
      db
        .prepare(
          'SELECT vertex_id, reference_id FROM vertices ORDER BY created_at_revision, vertex_id',
        )
        .all(),
    ).toEqual([
      { vertex_id: 'vertex-a', reference_id: 'V1' },
      { vertex_id: 'vertex-b', reference_id: 'V2' },
    ]);
    expect(
      db
        .prepare(
          'SELECT edge_id, reference_id FROM inference_edges ORDER BY created_at_revision, edge_id',
        )
        .all(),
    ).toEqual([
      { edge_id: 'edge-a', reference_id: 'E1' },
      { edge_id: 'edge-b', reference_id: 'E2' },
    ]);

    db.close();
  });

  it('splits a legacy multi-source edge into ordered independent En edges', () => {
    const { db } = createLegacyDatabase();
    const sessionId = 'legacy-split-session';
    const timestamp = '2026-01-01T00:00:00.000Z';
    migrateStorage(db);

    db.prepare(
      `INSERT INTO inference_edges (
         session_id, edge_id, reference_id, formula_id, label, state, cost, priority, conclusion,
         blocked_reason, dedupe_key, proposed_by_agent, created_at, created_at_revision,
         updated_at_revision
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sessionId,
      'legacy-edge',
      'E1',
      'legacy-formula-placeholder',
      'legacy combined inference',
      'Completed',
      2,
      3,
      'legacy conclusion',
      null,
      'k:legacy-combined-edge',
      'agent',
      timestamp,
      7,
      9,
    );
    const insertSource = db.prepare(
      'INSERT INTO edge_sources (session_id, edge_id, vertex_id, ordinal) VALUES (?,?,?,?)',
    );
    insertSource.run(sessionId, 'legacy-edge', 'source-a', 0);
    insertSource.run(sessionId, 'legacy-edge', 'source-b', 1);
    insertSource.run(sessionId, 'legacy-edge', 'source-c', 2);
    db.prepare(
      'INSERT INTO edge_targets (session_id, edge_id, vertex_id, ordinal) VALUES (?,?,?,?)',
    ).run(sessionId, 'legacy-edge', 'target', 0);
    db.prepare(
      `INSERT INTO evidence_questions (
         session_id, edge_id, question_id, prompt, normalized_prompt,
         answer, answered_by_agent, answered_at, answered_at_revision, ordinal
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sessionId,
      'legacy-edge',
      'question-1',
      'What proves this?',
      'what proves this?',
      'The archived evidence.',
      'agent',
      timestamp,
      8,
      0,
    );

    migrateStorage(db);
    migrateStorage(db);

    expect(
      db
        .prepare(
          `SELECT e.reference_id, s.vertex_id AS source_id, t.vertex_id AS target_id,
                  e.state, e.conclusion
           FROM inference_edges e
           JOIN edge_sources s ON s.session_id = e.session_id AND s.edge_id = e.edge_id
           JOIN edge_targets t ON t.session_id = e.session_id AND t.edge_id = e.edge_id
           WHERE e.session_id = ?
           ORDER BY e.reference_id`,
        )
        .all(sessionId),
    ).toEqual([
      {
        reference_id: 'E1',
        source_id: 'source-a',
        target_id: 'target',
        state: 'Completed',
        conclusion: 'legacy conclusion',
      },
      {
        reference_id: 'E2',
        source_id: 'source-b',
        target_id: 'target',
        state: 'Completed',
        conclusion: 'legacy conclusion',
      },
      {
        reference_id: 'E3',
        source_id: 'source-c',
        target_id: 'target',
        state: 'Completed',
        conclusion: 'legacy conclusion',
      },
    ]);
    expect(
      db
        .prepare('SELECT edge_id, question_id FROM evidence_questions WHERE session_id = ? ORDER BY edge_id')
        .all(sessionId),
    ).toHaveLength(3);
    expect(
      db
        .prepare(
          `SELECT COUNT(DISTINCT formula_id) AS formula_count
           FROM inference_edges WHERE session_id = ?`,
        )
        .get(sessionId),
    ).toEqual({ formula_count: 1 });

    db.close();
  });
});

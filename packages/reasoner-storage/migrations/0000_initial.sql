-- Reasoner Core initial schema.
-- Safe to run repeatedly: every statement is IF NOT EXISTS.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reasoning_sessions (
  session_id         TEXT PRIMARY KEY,
  goal_vertex_id     TEXT NOT NULL,
  goal_state         TEXT NOT NULL,
  strategy           TEXT NOT NULL,
  projection_policy  TEXT NOT NULL,
  max_edges          INTEGER NOT NULL,
  max_depth          INTEGER NOT NULL,
  max_lease_seconds  INTEGER NOT NULL,
  -- Optimistic concurrency counter; every committed mutation bumps it once.
  graph_revision     INTEGER NOT NULL CHECK (graph_revision >= 0),
  -- Session-wide monotonic event cursor; never reused, never reordered.
  last_event_seq     INTEGER NOT NULL DEFAULT 0,
  structural_error   TEXT,
  finished_reason    TEXT,
  created_by_agent   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vertices (
  session_id          TEXT NOT NULL REFERENCES reasoning_sessions(session_id) ON DELETE CASCADE,
  vertex_id           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  label               TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  dedupe_key          TEXT,
  created_by_agent    TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_at_revision INTEGER NOT NULL,
  PRIMARY KEY (session_id, vertex_id)
);

-- Enforces vertex de-duplication per session.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vertices_dedupe
  ON vertices (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS inference_edges (
  session_id          TEXT NOT NULL REFERENCES reasoning_sessions(session_id) ON DELETE CASCADE,
  edge_id             TEXT NOT NULL,
  label               TEXT NOT NULL,
  state               TEXT NOT NULL,
  cost                REAL NOT NULL,
  priority            REAL NOT NULL,
  conclusion          TEXT,
  blocked_reason      TEXT,
  dedupe_key          TEXT,
  proposed_by_agent   TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_at_revision INTEGER NOT NULL,
  updated_at_revision INTEGER NOT NULL,
  PRIMARY KEY (session_id, edge_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_edges_dedupe
  ON inference_edges (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_edges_state ON inference_edges (session_id, state);

-- Hyperedge premises. Normalised so a multi-source edge is not degraded.
CREATE TABLE IF NOT EXISTS edge_sources (
  session_id TEXT NOT NULL,
  edge_id    TEXT NOT NULL,
  vertex_id  TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (session_id, edge_id, vertex_id),
  FOREIGN KEY (session_id, edge_id) REFERENCES inference_edges(session_id, edge_id) ON DELETE CASCADE
);

-- Hyperedge conclusions. Separate table so multi-target edges round-trip intact.
CREATE TABLE IF NOT EXISTS edge_targets (
  session_id TEXT NOT NULL,
  edge_id    TEXT NOT NULL,
  vertex_id  TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (session_id, edge_id, vertex_id),
  FOREIGN KEY (session_id, edge_id) REFERENCES inference_edges(session_id, edge_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence_questions (
  session_id           TEXT NOT NULL,
  edge_id              TEXT NOT NULL,
  question_id          TEXT NOT NULL,
  prompt               TEXT NOT NULL,
  normalized_prompt    TEXT NOT NULL,
  answer               TEXT,
  answered_by_agent    TEXT,
  answered_at          TEXT,
  answered_at_revision INTEGER,
  ordinal              INTEGER NOT NULL,
  PRIMARY KEY (session_id, edge_id, question_id),
  FOREIGN KEY (session_id, edge_id) REFERENCES inference_edges(session_id, edge_id) ON DELETE CASCADE
);

-- One question text per edge; evidence questions stay edge attributes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_questions_normalized
  ON evidence_questions (session_id, edge_id, normalized_prompt);

CREATE TABLE IF NOT EXISTS edge_leases (
  session_id         TEXT NOT NULL,
  edge_id            TEXT NOT NULL,
  lease_id           TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  acquired_at        TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  input_context_hash TEXT NOT NULL,
  released_at        TEXT,
  PRIMARY KEY (session_id, edge_id, lease_id),
  FOREIGN KEY (session_id, edge_id) REFERENCES inference_edges(session_id, edge_id) ON DELETE CASCADE
);

-- At most one live lease per edge: the concurrency guarantee is a DB constraint,
-- not an in-process convention.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_lease
  ON edge_leases (session_id, edge_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS graph_events (
  session_id     TEXT NOT NULL REFERENCES reasoning_sessions(session_id) ON DELETE CASCADE,
  event_seq      INTEGER NOT NULL,
  graph_revision INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  vertex_id      TEXT,
  edge_id        TEXT,
  actor_agent_id TEXT NOT NULL,
  detail_json    TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  -- event_seq is the paging cursor; several events may share graph_revision.
  PRIMARY KEY (session_id, event_seq)
);

CREATE INDEX IF NOT EXISTS ix_events_revision ON graph_events (session_id, graph_revision);

CREATE TABLE IF NOT EXISTS context_projections (
  projection_id       TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES reasoning_sessions(session_id) ON DELETE CASCADE,
  subject_kind        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  policy              TEXT NOT NULL,
  graph_revision      INTEGER NOT NULL,
  snapshot_hash       TEXT NOT NULL,
  context_hash        TEXT NOT NULL,
  included_vertex_ids TEXT NOT NULL,
  included_edge_ids   TEXT NOT NULL,
  omitted_vertex_ids  TEXT NOT NULL,
  omitted_edge_ids    TEXT NOT NULL,
  expansion_handles   TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_projections_subject
  ON context_projections (session_id, subject_kind, subject_id, created_at);

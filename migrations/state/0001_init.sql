-- Cohorte state store, schema 1 (DESIGN 2.4). FROZEN in Wave 0: a change is a NEW numbered migration.
-- Every table is STRICT, every JSON column carries CHECK (json_valid(...)), and every table is column-for-column
-- equal to its record type (packages/persistence/src/records.ts, TABLE_COLUMNS; proved by the DDL parity test).
-- The migrator runs this file inside one transaction and records it in `migrations` itself.

CREATE TABLE migrations ( id INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL,
  cohorte_version TEXT NOT NULL ) STRICT;

CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL ) STRICT, WITHOUT ROWID;

-- profile: NO SQL CHECK. ADR-0018 is provisional: the known profiles are validated in TypeScript (table registry), so a
-- fourth profile is not a state migration.
-- The six columns marked (*) are NULL while the run is IDLE: only the HOST can compute them, behind the T04 guards
-- snapshot.captured, runtime.pin-valid and repo.base-resolved, and it fills them in the T04 transaction together with
-- pipeline.started. The CLI writes what it knows when it creates the row: profile, table_version, spec, title,
-- base_branch (the requested one) and pinned_install_dir (NOT NULL: a run belongs to its install from its first byte).
CREATE TABLE runs ( run_id TEXT PRIMARY KEY, profile TEXT NOT NULL, table_version INTEGER NOT NULL,
  spec_id TEXT NOT NULL, spec_sha256 TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, resume_to TEXT,
  stop_json TEXT CHECK (stop_json IS NULL OR json_valid(stop_json)),
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  last_sequence INTEGER NOT NULL DEFAULT 0, last_hash TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
  snapshot_digest TEXT /* (*) */,
  runtime_pin_json TEXT /* (*) */ CHECK (runtime_pin_json IS NULL OR json_valid(runtime_pin_json)),
  plan_json TEXT /* (*) */ CHECK (plan_json IS NULL OR json_valid(plan_json)),
  pinned_install_dir TEXT NOT NULL,
  base_branch TEXT NOT NULL, base_sha TEXT /* (*) */, integration_branch TEXT /* (*) */, integration_head TEXT,
  approved_tree_digest TEXT,
  skip_waivers_json TEXT CHECK (skip_waivers_json IS NULL OR json_valid(skip_waivers_json)),
  zones_json TEXT /* (*) */ CHECK (zones_json IS NULL OR json_valid(zones_json)),
  host_id TEXT, host_pid INTEGER, host_start_token TEXT, host_heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
  schema_version INTEGER NOT NULL, cohorte_version TEXT NOT NULL,
  purgeable INTEGER NOT NULL DEFAULT 0 CHECK (purgeable IN (0, 1)),
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  CHECK (state IN ('IDLE','CANCELLED','FAILED') OR (snapshot_digest IS NOT NULL AND runtime_pin_json IS NOT NULL
    AND plan_json IS NOT NULL AND base_sha IS NOT NULL AND integration_branch IS NOT NULL AND zones_json IS NOT NULL))
) STRICT;
CREATE INDEX runs_by_state ON runs(state, started_at);

CREATE TABLE events ( run_id TEXT NOT NULL REFERENCES runs(run_id), sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, timestamp TEXT NOT NULL, source TEXT NOT NULL,
  phase_run_id TEXT, agent_id TEXT, causation_id TEXT, severity TEXT NOT NULL, summary TEXT NOT NULL,
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),          -- the full SEALED envelope, canonical JSON: the hashed unit
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,                   -- hash = sha256(prev_hash || '\n' || envelope): local append-only journal (spec 23)
  PRIMARY KEY (run_id, sequence) ) STRICT, WITHOUT ROWID;
CREATE INDEX events_by_type ON events(run_id, type, sequence);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events WHEN (SELECT purgeable FROM runs WHERE run_id = OLD.run_id) = 0
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE transitions ( transition_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  def_id TEXT NOT NULL, table_version INTEGER NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  reason TEXT NOT NULL, actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  guards_json TEXT NOT NULL CHECK (json_valid(guards_json)), effects_json TEXT NOT NULL CHECK (json_valid(effects_json)),
  idempotency_key TEXT NOT NULL, event_id TEXT NOT NULL,
  UNIQUE (run_id, idempotency_key) ) STRICT;

CREATE TABLE phases ( run_id TEXT NOT NULL REFERENCES runs(run_id), phase_run_id TEXT NOT NULL, state TEXT NOT NULL,
  iteration INTEGER NOT NULL, status TEXT NOT NULL, outcome TEXT,
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)), started_at TEXT, ended_at TEXT,
  PRIMARY KEY (run_id, phase_run_id) ) STRICT, WITHOUT ROWID;

CREATE TABLE agents ( run_id TEXT NOT NULL REFERENCES runs(run_id), agent_id TEXT NOT NULL, phase_run_id TEXT NOT NULL,
  role TEXT NOT NULL, surface TEXT, label TEXT NOT NULL, state TEXT NOT NULL,
  attempt INTEGER NOT NULL, incarnation INTEGER NOT NULL, max_attempts INTEGER NOT NULL, max_incarnations INTEGER NOT NULL,
  model_json TEXT NOT NULL CHECK (json_valid(model_json)),
  effective_model_json TEXT CHECK (effective_model_json IS NULL OR json_valid(effective_model_json)),
  auth_mode TEXT, slot TEXT, context_sha256 TEXT, grants_digest TEXT,
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)), summary TEXT,
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  pending_approval TEXT, runtime_ref_json TEXT CHECK (runtime_ref_json IS NULL OR json_valid(runtime_ref_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_id) ) STRICT, WITHOUT ROWID;

CREATE TABLE agent_incarnations ( run_id TEXT NOT NULL, agent_id TEXT NOT NULL, incarnation INTEGER NOT NULL,
  attempt INTEGER NOT NULL, state TEXT NOT NULL, cause TEXT, pid INTEGER, start_token TEXT, host_nonce TEXT,
  runtime_ref_json TEXT CHECK (runtime_ref_json IS NULL OR json_valid(runtime_ref_json)), stop TEXT, reason TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)), started_at TEXT, ended_at TEXT,
  PRIMARY KEY (run_id, agent_id, incarnation),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, agent_id) ) STRICT, WITHOUT ROWID;

CREATE TABLE worktrees ( run_id TEXT NOT NULL REFERENCES runs(run_id), slot TEXT NOT NULL, path TEXT NOT NULL, branch TEXT,
  base_sha TEXT NOT NULL, checkpoint_sha TEXT NOT NULL, last_tree_digest TEXT, lockfile_sha256 TEXT, provision_key TEXT,
  deps_manifest_sha256 TEXT /* 5.7: digest of the provisioned dependency tree */, holder_agent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent','ready','held','in-doubt','quarantined','removed')),
  PRIMARY KEY (run_id, slot) ) STRICT, WITHOUT ROWID;

-- dirty paths since the last Cohorte commit, each with the content hash Cohorte expects (4.4); sha256 NULL = deleted
CREATE TABLE worktree_ledger ( run_id TEXT NOT NULL, slot TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT,
  effect_id TEXT NOT NULL, effect_seq INTEGER NOT NULL,
  PRIMARY KEY (run_id, slot, path) ) STRICT, WITHOUT ROWID;

CREATE TABLE effects ( effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL, replay_class TEXT NOT NULL CHECK (replay_class IN ('idempotent','verifiable','at-most-once')),
  state TEXT NOT NULL CHECK (state IN ('intent','done','failed','in-doubt','compensated')),
  agent_id TEXT, tool_call_id TEXT, slot TEXT,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)), verify_json TEXT NOT NULL CHECK (json_valid(verify_json)),
  pre_state_json TEXT CHECK (pre_state_json IS NULL OR json_valid(pre_state_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  consumes_grant TEXT, compensated_by TEXT, fencing_token INTEGER NOT NULL,
  intent_seq INTEGER NOT NULL, done_seq INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (run_id, idempotency_key) ) STRICT;
CREATE INDEX effects_open ON effects(run_id, state) WHERE state IN ('intent','in-doubt');

CREATE TABLE approvals ( approval_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL, agent_id TEXT, incarnation INTEGER, tool_call_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','allow-once','allow-for-run','deny','expired','superseded')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),   -- ApprovalRequest incl. the NORMALISED pending call
  grant_key TEXT NOT NULL,                                       -- sha256(tool | normalised call | pre-state binding): what a decision is valid for (4.5).
                                                                 --   binding = target beforeSha256 (write/patch) | the slot's content-addressed treeDigest (command): NEVER a commit sha
  decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
  command_auth_json TEXT CHECK (command_auth_json IS NULL OR json_valid(command_auth_json)),
                                                                 -- actor, commandId, answer, note, decidedAt + {scheme,value} of the resolving command (spec 23 "signées/loggées")
  consumed_by_effect TEXT,                                       -- allow-once: set in the intent transaction of the consuming effect (live call OR host-side replay, 4.5)
  requested_seq INTEGER NOT NULL, resolved_seq INTEGER, expires_at TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE (run_id, idempotency_key) ) STRICT;
CREATE INDEX approvals_by_grant ON approvals(run_id, grant_key);
CREATE INDEX approvals_pending ON approvals(run_id, created_at) WHERE status = 'pending';

CREATE TABLE budgets ( run_id TEXT NOT NULL REFERENCES runs(run_id), level TEXT NOT NULL, scope_id TEXT NOT NULL,
  consumed_json TEXT NOT NULL CHECK (json_valid(consumed_json)), limit_json TEXT NOT NULL CHECK (json_valid(limit_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, level, scope_id) ) STRICT, WITHOUT ROWID;

CREATE TABLE artifacts ( artifact_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), kind TEXT NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK (bytes >= 0), media_type TEXT, agent_id TEXT,
  phase_run_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, artifact_id) ) STRICT, WITHOUT ROWID;

CREATE TABLE findings ( run_id TEXT NOT NULL REFERENCES runs(run_id), finding_id TEXT NOT NULL, phase_run_id TEXT NOT NULL,
  agent_id TEXT, severity TEXT NOT NULL, status TEXT NOT NULL,
  finding_json TEXT NOT NULL CHECK (json_valid(finding_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, finding_id) ) STRICT, WITHOUT ROWID;

-- run_id has no foreign key: a project-scoped command names no run, and the inbox is written by non-owner processes.
CREATE TABLE commands ( command_id TEXT PRIMARY KEY, run_id TEXT, type TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)), auth_scheme TEXT, auth_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','rejected')), claimed_by TEXT, result_event_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL ) STRICT;
CREATE INDEX commands_pending ON commands(run_id, created_at, command_id) WHERE status = 'pending';

-- overlap decided inside BEGIN IMMEDIATE
CREATE TABLE locks ( lock_id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('shared','exclusive')),
  owner_run_id TEXT, owner_host_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start_token TEXT NOT NULL,
  fencing_token INTEGER NOT NULL, zones_json TEXT CHECK (zones_json IS NULL OR json_valid(zones_json)),
  lease_expires_at TEXT NOT NULL, acquired_at TEXT NOT NULL ) STRICT;
CREATE INDEX locks_by_key ON locks(scope, key);

CREATE TABLE snapshots ( run_id TEXT NOT NULL REFERENCES runs(run_id), at_sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL, cohorte_version TEXT NOT NULL, state_sha256 TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY (run_id, at_sequence) ) STRICT, WITHOUT ROWID;

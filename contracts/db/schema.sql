-- Agora durable store (ADR 0005). Applied from scratch by `npm run db:reset`; there are no
-- incremental migrations before first release. Every table is introduced by the implementation
-- slice that specifies its behavior, with the authority boundary it belongs to:
--   canonical history (Intent events, Workstream facts), operational control (reconciliation work),
--   rebuildable projections, opaque Saves.

-- S2 canonical history — Intents ---------------------------------------------------------------

CREATE TABLE workstreams (
  id uuid PRIMARY KEY,
  owner_principal text NOT NULL,
  title text NOT NULL,
  create_request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_principal, create_request_key)
);

CREATE TABLE workstream_intent_events (
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  intent_seq bigint NOT NULL CHECK (intent_seq > 0),
  intent jsonb NOT NULL,
  request_key text NOT NULL,
  principal text NOT NULL,
  revision_set jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workstream_id, intent_seq),
  UNIQUE (workstream_id, request_key)
);

-- S2 operational control — workset ---------------------------------------------------------------

-- At most one row per Workstream (ADR 0003): a coalescing operational workset, not a message
-- queue. Correlations (engine contract): intent_seq orders desired-state events;
-- work_generation protects against any older pass deleting a newer wake, including a wake for the
-- same Intent; claim_token/lease_until select one bounded mutation attempt. attempt_count,
-- blocking_cause and last_error are retry bookkeeping, never convergence proof.
CREATE TABLE workstream_reconciliation_work (
  workstream_id uuid PRIMARY KEY REFERENCES workstreams(id),
  intent_seq bigint NOT NULL,
  work_generation bigint NOT NULL,
  due_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid NULL,
  lease_until timestamptz NULL,
  attempt_count int NOT NULL DEFAULT 0,
  blocking_cause text NULL,
  last_error jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Global allocator: generations are never reused after a row is deleted and recreated (ABA,
-- ENGINE-005); a per-row counter would restart at 1.
CREATE SEQUENCE work_generation_seq AS bigint;

-- Authoring and drift wakes may only advance the pointed-to Intent. A decrease would make a newer
-- obligation point at older desired state; delete + reinsert is the only way to revisit, and the
-- global generation sequence fences workers from the deleted incarnation.
CREATE FUNCTION work_intent_seq_never_regresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_seq < OLD.intent_seq THEN
    RAISE EXCEPTION 'intent_seq cannot decrease on workstream_reconciliation_work (workstream %: % -> %)',
      OLD.workstream_id, OLD.intent_seq, NEW.intent_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workstream_reconciliation_work_no_regression
BEFORE UPDATE ON workstream_reconciliation_work
FOR EACH ROW EXECUTE FUNCTION work_intent_seq_never_regresses();

-- S2 authority boundaries (ADR 0005) -------------------------------------------------------------

-- Cluster-global roles: creation must be race-safe across concurrent fresh databases (findings
-- §5). Each CREATE gets its own subtransaction catching both SQLSTATEs the collision surfaces as.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['agora_product', 'agora_engine']
  LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON workstreams, workstream_intent_events, workstream_reconciliation_work FROM PUBLIC;
REVOKE ALL ON SEQUENCE work_generation_seq FROM PUBLIC;

-- Product: append immutable Intents, read Workstreams; create/reset its own work obligations in
-- the authoring transaction (never delete them — finalization is the engine's).
GRANT SELECT, INSERT, UPDATE (title, updated_at), UPDATE (create_request_key) ON workstreams TO agora_product;
GRANT SELECT, INSERT ON workstream_intent_events TO agora_product;
GRANT SELECT, INSERT ON workstream_reconciliation_work TO agora_product;
GRANT UPDATE (
  intent_seq, work_generation, due_at, claim_token, lease_until,
  attempt_count, blocking_cause, last_error, updated_at
) ON workstream_reconciliation_work TO agora_product;

-- Engine: manage the workset and read the desired state; it never writes Intents or Workstreams.
GRANT SELECT ON workstream_intent_events TO agora_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON workstream_reconciliation_work TO agora_engine;
GRANT USAGE ON SEQUENCE work_generation_seq TO agora_product, agora_engine;

-- S3 canonical history — facts and Sessions ------------------------------------------------------

-- One canonical ordered fact stream per Workstream (ADR 0002, ADR 0004). head_seq is the
-- allocator: appends take the Workstream row lock (the same one Intent authoring takes), so
-- birth, Intent events and facts are totally ordered. The trigger forbids a decrease; the
-- delete+recreate ABA concern does not apply to a row that is never deleted.
ALTER TABLE workstreams ADD COLUMN head_seq bigint NOT NULL DEFAULT 0;

-- SELECT + UPDATE (head_seq) let the engine take the FOR UPDATE row lock while reserving owner
-- attempts (SELECT FOR UPDATE requires both — findings §5); the engine never actually moves the
-- head, that stays the product's fact-append path.
GRANT SELECT ON workstreams TO agora_engine;
GRANT UPDATE (head_seq) ON workstreams TO agora_engine;

CREATE FUNCTION workstream_head_seq_never_regresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.head_seq < OLD.head_seq THEN
    RAISE EXCEPTION 'head_seq cannot decrease on workstreams (workstream %: % -> %)',
      OLD.id, OLD.head_seq, NEW.head_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workstreams_head_seq_no_regression
BEFORE UPDATE ON workstreams
FOR EACH ROW EXECUTE FUNCTION workstream_head_seq_never_regresses();

-- Sessions are filtered views of the Workstream stream with their own identity — NOT a second
-- journal and NOT a lifecycle (no phase column; ADR 0002, ADR 0003). opened_at_seq is the seq of
-- the session.opened fact; cutoff_h is the head before any fact of this Session (CONT-001/002).
-- The partial unique index enforces at most one current execution per Workstream (ADR 0003).
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  ordinal int NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_at_seq bigint NOT NULL,
  cutoff_h bigint NOT NULL,
  pod_uid text NOT NULL,
  provenance jsonb NOT NULL,
  attribution_ended_at timestamptz NULL,
  UNIQUE (workstream_id, ordinal),
  UNIQUE (workstream_id, pod_uid)
);

CREATE UNIQUE INDEX sessions_one_current_per_workstream
  ON sessions (workstream_id) WHERE attribution_ended_at IS NULL;

CREATE TABLE workstream_facts (
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  seq bigint NOT NULL,
  session_id uuid NULL REFERENCES sessions(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  causation jsonb NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workstream_id, seq)
);

CREATE INDEX workstream_facts_by_session ON workstream_facts (session_id, seq);

-- S3 projections ---------------------------------------------------------------------------------

-- Disposable, checkpointed, rebuildable read models (ADR 0004: readable models are projections).
-- through_seq is the last fact seq folded for this projector on this Workstream; a projector
-- version change forces a rebuild (checkpoint row replaced from seq 0).
CREATE TABLE projection_checkpoints (
  projector text NOT NULL,
  workstream_id uuid NOT NULL,
  projector_version text NOT NULL,
  through_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (projector, workstream_id)
);

CREATE TABLE projection_sessions (
  workstream_id uuid NOT NULL,
  session_id uuid NOT NULL,
  ordinal int NOT NULL,
  pod_uid text NOT NULL,
  opened_at timestamptz NOT NULL,
  cutoff_h bigint NOT NULL,
  attribution_ended_at timestamptz NULL,
  image_digest text NULL,
  first_seq bigint NOT NULL,
  latest_seq bigint NOT NULL,
  PRIMARY KEY (workstream_id, session_id)
);

-- S3 authority boundaries ------------------------------------------------------------------------

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['agora_projector']
  LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON sessions, workstream_facts, projection_checkpoints, projection_sessions FROM PUBLIC;

-- Product (control plane / runtime birth): append facts under the Workstream lock, advance the
-- head, open and end Sessions. Facts and Sessions are immutable once written — no UPDATE, no
-- DELETE on workstream_facts; only the attribution boundary on sessions may be closed.
GRANT UPDATE (head_seq) ON workstreams TO agora_product;
GRANT SELECT, INSERT, UPDATE (attribution_ended_at) ON sessions TO agora_product;
GRANT SELECT, INSERT ON workstream_facts TO agora_product;

-- Projector: read canonical state, own the projection tables and their checkpoints. It never
-- writes history.
GRANT SELECT ON workstream_facts, sessions TO agora_projector;
GRANT SELECT, INSERT, UPDATE, DELETE ON projection_checkpoints, projection_sessions TO agora_projector;

-- S4 canonical history — ACP envelopes ------------------------------------------------------------

-- Indexing metadata beside the envelope (ADR 0004): NOT a second model. payload holds the raw
-- NDJSON frame text bound as jsonb; these columns exist so validation, correlation and the
-- projectors never need to parse the payload. observation_id is the stable occurrence identity —
-- two identical envelopes are two facts.
ALTER TABLE workstream_facts
  ADD COLUMN direction text NULL,
  ADD COLUMN rpc_kind text NULL,
  ADD COLUMN method text NULL,
  ADD COLUMN correlated_method text NULL,
  ADD COLUMN rpc_id jsonb NULL,
  ADD COLUMN command_id uuid NULL,
  ADD COLUMN connection_id text NULL,
  ADD COLUMN observation_id text NULL,
  ADD COLUMN frame_size integer NULL;

CREATE INDEX workstream_facts_acp_method ON workstream_facts (workstream_id, method);
CREATE UNIQUE INDEX workstream_facts_observation ON workstream_facts (observation_id);

-- Invalid frames are never canonical facts: only content-free diagnostics remain (direction,
-- error class, size, digest). ADR 0004, findings §1.
CREATE TABLE acp_diagnostics (
  id uuid PRIMARY KEY,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  session_id uuid NULL,
  direction text NOT NULL,
  error_class text NOT NULL,
  size integer NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- S4 operational — command dispatches -------------------------------------------------------------

-- Prompts (and later cancels/handoffs) are commands with a durable dispatch reservation
-- (engine.md — Prompt delivery and context creation). `reserved` is committed BEFORE the send;
-- `dispatched` after the transport write; `responded` when the correlated response lands.
-- `unknown` is the honest crash/loss state: it gates the next turn until recovery resolves it.
-- `rejected_before_acceptance` means provably never sent. A user retry is a NEW command linked to
-- its unresolved predecessor.
CREATE TABLE command_dispatches (
  id uuid PRIMARY KEY,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  kind text NOT NULL CHECK (kind IN ('prompt', 'cancel', 'handoff')),
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'dispatched', 'responded', 'unknown', 'rejected_before_acceptance')),
  request_key text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz NULL,
  settled_at timestamptz NULL,
  linked_predecessor uuid NULL REFERENCES command_dispatches(id),
  UNIQUE (workstream_id, request_key)
);

CREATE INDEX command_dispatches_workstream_state ON command_dispatches (workstream_id, state);

-- S4 projections — items, turns, feed_events ------------------------------------------------------

CREATE TABLE projection_items (
  id uuid PRIMARY KEY,
  workstream_id uuid NOT NULL,
  session_id uuid NOT NULL,
  item_kind text NOT NULL,
  entity_key text NOT NULL,
  value jsonb NOT NULL,
  content_sha256 text NOT NULL,
  first_seq bigint NOT NULL,
  latest_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workstream_id, item_kind, entity_key)
);

CREATE TABLE projection_turns (
  id uuid PRIMARY KEY,
  workstream_id uuid NOT NULL,
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
  stop_reason text NULL,
  usage jsonb NULL,
  first_seq bigint NOT NULL,
  latest_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workstream_id, command_id)
);

-- Append-only per-Workstream position stream. Position comes from a global identity sequence and
-- is never reused or truncated by a rebuild (docs/plans S04 Step 5).
CREATE TABLE feed_events (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workstream_id uuid NOT NULL,
  through_seq bigint NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'remove', 'status', 'reset')),
  item_id uuid NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feed_events_workstream ON feed_events (workstream_id, position);

-- S4 grants ---------------------------------------------------------------------------------------

GRANT UPDATE (direction, rpc_kind, method, correlated_method, rpc_id, command_id, connection_id, observation_id, frame_size) ON workstream_facts TO agora_product;
GRANT SELECT, INSERT ON acp_diagnostics TO agora_product;
GRANT SELECT, INSERT, UPDATE ON command_dispatches TO agora_product;
GRANT SELECT, INSERT, UPDATE, DELETE ON projection_items, projection_turns TO agora_projector;
GRANT SELECT, INSERT ON feed_events TO agora_projector, agora_product;
GRANT USAGE, SELECT ON SEQUENCE feed_events_position_seq TO agora_projector, agora_product;

-- S4: the control-plane API serves product reads from the projections and diagnostics (read-only;
-- the projector keeps sole write authority over the projection tables).
GRANT SELECT ON projection_items, projection_turns, acp_diagnostics TO agora_product;

-- S5 operational — mutation epochs, owner attempts, target retirements, wake sources --------------

-- One epoch per Workstream, issued by the control plane on claim transfer; each owner mirrors the
-- last epoch it accepted and rejects anything older (engine.md — Effect ownership).
CREATE TABLE mutation_epochs (
  workstream_id uuid PRIMARY KEY REFERENCES workstreams(id),
  epoch bigint NOT NULL,
  owner_claim text NULL,
  issued_at timestamptz NOT NULL DEFAULT now()
);

-- The durable reservation that precedes every dispatch: a crash between dispatch and settle leaves
-- `dispatched`, which recovery treats as possibly accepted. attempt_key is the stable identity —
-- a reused key with a different digest is rejected_key_mismatch at the owner.
CREATE TABLE owner_attempts (
  attempt_key text PRIMARY KEY,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  epoch bigint NOT NULL,
  operation text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('concrete', 'reserved')),
  target_id text NOT NULL,
  payload_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'unknown', 'superseded')),
  dispatch_owner text NOT NULL,
  recovery_owner text NULL,
  revision_set jsonb NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL
);

CREATE INDEX owner_attempts_workstream_state ON owner_attempts (workstream_id, state);

-- Retired targets (Pod UID, Agent id, reserved slot) never accept positive mutations or rebinding
-- again; concrete-target cleanup stays authorized. Retirement survives work-row deletion.
CREATE TABLE target_retirements (
  target_id text PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('concrete', 'reserved')),
  workstream_id uuid NOT NULL,
  reason text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now()
);

-- The engine's wake registry (engine.md — Watches and recovery sweeps): each source keeps its
-- cursor; a bounded sweep can re-enqueue Workstreams absent from the workset.
CREATE TABLE wake_sources (
  source text PRIMARY KEY,
  cursor text NULL,
  last_seen timestamptz NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mutation_epochs, owner_attempts, target_retirements, wake_sources TO agora_engine;
GRANT SELECT ON owner_attempts, target_retirements TO agora_product;

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

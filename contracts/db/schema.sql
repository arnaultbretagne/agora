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

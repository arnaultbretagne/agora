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
  -- S8: the bound live ACP context, set once START (or RESTORE, S9) verifies the adapter's own
  -- returned context id and binds it to the Pod's current process generation (SESSION-A06: a
  -- process restart bumps the generation, invalidating this exact row's context without a new
  -- Session — observation.session reads process_generation fresh from runtime-control, never
  -- from here, and treats a mismatch as `unusable`, not absent).
  acp_context_id text NULL,
  process_generation int NOT NULL DEFAULT 0,
  -- The P4 bridge token minted at gate release (apps/runtime-control's gate_release response) —
  -- the one credential this Session's control-plane connection needs to reconnect to the bridge.
  -- Never the OneCLI bearer (that stays Broker-private, ADR 0009) and never sent anywhere but the
  -- bridge's own WebSocket handshake.
  bridge_token text NULL,
  -- S9: the opening range's LOWER bound. 0 is the cross-seed (nothing was carried in); a restored
  -- Save gives the frontier that Save could actually prove (CONT-009), never the journal head and
  -- never the Save's own optimistic idea of what it contained. Together with cutoff_h it fixes the
  -- opening range (W, H] once, at birth or at restore — never re-sampled at REFILL dispatch.
  origin_w bigint NOT NULL DEFAULT 0,
  origin_save_id uuid NULL,
  UNIQUE (workstream_id, ordinal)
);

CREATE UNIQUE INDEX sessions_one_current_per_workstream
  ON sessions (workstream_id) WHERE attribution_ended_at IS NULL;

-- S8 Step 4b: at most one CURRENT (unended) Session per (Workstream, Pod) — openSession's own
-- idempotency guard against the same BUILD's replayed response creating two rows. Deliberately NOT
-- a plain UNIQUE(workstream_id, pod_uid): a hot Session boundary (execution.md "Hot Session
-- boundaries") ends one Session's attribution and opens its successor on the SAME retained Pod —
-- a flat constraint would forbid that legitimate case outright, not just the replay it exists to
-- catch. sessions_one_current_per_workstream above already enforces "at most one current Session,
-- full stop" — this index narrows that same guarantee to a given Pod specifically.
CREATE UNIQUE INDEX sessions_one_current_per_workstream_pod
  ON sessions (workstream_id, pod_uid) WHERE attribution_ended_at IS NULL;

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
GRANT SELECT, INSERT, UPDATE (attribution_ended_at, acp_context_id, process_generation, bridge_token, origin_w, origin_save_id) ON sessions TO agora_product;
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

-- S6 operational — runtime-control retirement obligations ------------------------------------------------

-- Recorded when a Pod is deleted with its ORIGINAL deadline; discharged only on P6 termination
-- evidence or verified fencing. Survives runtime-control restarts (OFF-002) and work-row deletion.
-- Keyed by the Pod's stable deterministic name (k8s-labels.ts podName()), not its K8s-assigned uid,
-- so the obligation stays discoverable by pre-recorded correlation even after the Pod is fully gone.
CREATE TABLE retirement_obligations (
  pod_name text PRIMARY KEY,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  reason text NOT NULL,
  deadline timestamptz NOT NULL,
  -- The node last observed hosting the Pod, recorded at cleanup time (P6: a force-deleted Pod's
  -- absence only counts as termination evidence once that node is confirmed Ready — a partitioned
  -- or NotReady node leaves the obligation unresolved).
  node_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retirement_obligations_workstream ON retirement_obligations (workstream_id);

GRANT SELECT, INSERT, DELETE ON retirement_obligations TO agora_engine;
GRANT SELECT ON retirement_obligations TO agora_product;

-- S6/S7 operational — every owner's own owner record (engine.md — the owner request protocol; P5,
-- one shared shape, per-owner persistence: runtime-control S6, broker S7, keyed by `owner` so
-- neither can see or collide with the other's rows). Mirrors packages/owner-requests' OwnerRecord:
-- last accepted epoch per Workstream, one row per attempt key (idempotent replay by digest), and
-- targets this owner has itself retired (positive operations refuse them forever; concrete-target
-- cleanup stays authorized). Independent of the engine's own mutation_epochs/owner_attempts, which
-- record the dispatch side, not the owner's — packages/owner-requests' PgOwnerGate is the one
-- implementation every owner embeds instead of re-deciding the contract.
CREATE TABLE owner_record_epochs (
  owner text NOT NULL,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  epoch bigint NOT NULL,
  PRIMARY KEY (owner, workstream_id)
);

CREATE TABLE owner_record_attempts (
  owner text NOT NULL,
  attempt_key text NOT NULL,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  payload_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, attempt_key)
);

CREATE INDEX owner_record_attempts_workstream ON owner_record_attempts (owner, workstream_id);

CREATE TABLE owner_record_retired_targets (
  owner text NOT NULL,
  target_id text NOT NULL,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, target_id)
);

GRANT SELECT, INSERT, UPDATE ON owner_record_epochs TO agora_engine;
GRANT SELECT, INSERT ON owner_record_attempts TO agora_engine;
GRANT SELECT, INSERT ON owner_record_retired_targets TO agora_engine;
GRANT SELECT ON owner_record_epochs, owner_record_attempts, owner_record_retired_targets TO agora_product;

-- ---------------------------------------------------------------------------
-- S9 custody — Saves (metadata), payloads (a separate role), Anchors, invalidations
-- ---------------------------------------------------------------------------
-- ADR 0008: a Save is native bytes plus the metadata that makes them verifiable; core never reads
-- the bytes. The split below is the whole point of two roles: the control plane owns Save METADATA
-- (it decides what was captured and what may be published), runtime-control's transport owns the
-- BYTES (it streams them into a Pod before launch) — and neither can do the other's job.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['agora_custody_meta', 'agora_custody_payload']
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

-- Immutable once written. There is deliberately no `consumer` or `restored_into` column: a Save
-- records what was captured, never who later used it (ADR 0008 — a Save is not a lifecycle).
CREATE TABLE saves (
  id uuid PRIMARY KEY,
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  -- The Session that PRODUCED the capture; a restore always belongs to a new Session (CONT-003).
  session_id uuid NOT NULL REFERENCES sessions(id),
  harness_id text NOT NULL,
  format_id text NOT NULL,
  format_version int NOT NULL,
  driver_revision text NOT NULL,
  image_digest text NOT NULL,
  byte_length bigint NOT NULL,
  checksum text NOT NULL,
  -- What the driver PROVED was incorporated, never a copy of the journal head (CONT-009).
  frontier_w bigint NOT NULL,
  seed_policy_revision text NOT NULL,
  native_origin jsonb NOT NULL,
  workspace_deps jsonb NOT NULL,
  -- The capture key: repeating a capture discovers the same Save instead of writing a second one.
  pod_uid text NOT NULL,
  process_generation int NOT NULL,
  context_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pod_uid, process_generation, context_id, frontier_w, driver_revision)
);

CREATE INDEX saves_by_workstream ON saves (workstream_id, created_at DESC);

-- The bytes, reachable only through the payload role. Core (product/engine/projector) has no grant
-- here at all, which is what "core never reads Save bytes" means in practice rather than in prose.
CREATE TABLE save_payloads (
  save_id uuid PRIMARY KEY REFERENCES saves(id),
  bytes bytea NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now()
);

-- One Anchor per (Workstream, harness): the newest Save that harness may be restored from.
CREATE TABLE anchors (
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  harness_id text NOT NULL,
  save_id uuid NOT NULL REFERENCES saves(id),
  frontier_w bigint NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workstream_id, harness_id)
);

-- Append-only evidence that a Save (optionally only under one driver revision) must not be used.
-- A temporary store outage is NOT an invalidation: only verified incompatibility lands here
-- (CONT-008), so a transient failure can never permanently exclude a healthy Save.
CREATE TABLE save_invalidations (
  id uuid PRIMARY KEY,
  save_id uuid NOT NULL REFERENCES saves(id),
  driver_revision text NULL,
  cause text NOT NULL,
  verifier text NOT NULL,
  target text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX save_invalidations_by_save ON save_invalidations (save_id);

-- S9 Step 3 — bounded preservation at shutdown (OFF-001, OFF-002). One row per shutdown attempt on
-- one incarnation. `deadline_at` is pinned the FIRST time TURN_OFF runs and is never re-derived:
-- a controller that restarts mid-shutdown discovers the deadline it already owes rather than
-- granting itself a fresh budget, which is the whole of OFF-002. Termination does not depend on any
-- of this — it proceeds whether or not a Save was captured; the row is what makes the LOSS honest.
CREATE TABLE shutdowns (
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  incarnation text NOT NULL,
  session_id uuid NULL REFERENCES sessions(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  -- pending -> captured | refused | ineligible | expired. Never blocks termination in any state.
  capture_outcome text NOT NULL DEFAULT 'pending',
  capture_detail text NULL,
  save_id uuid NULL REFERENCES saves(id),
  -- published | rejected_stale_expectation | rejected_frontier_not_ahead | not_attempted
  anchor_outcome text NULL,
  terminated_at timestamptz NULL,
  PRIMARY KEY (workstream_id, incarnation)
);

REVOKE ALL ON saves, save_payloads, anchors, save_invalidations, shutdowns FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON shutdowns TO agora_product;

-- Control plane: writes and reads Save metadata, publishes Anchors, records invalidations. No
-- UPDATE or DELETE on saves (immutable) and NO grant of any kind on save_payloads.
GRANT SELECT, INSERT ON saves TO agora_product;
GRANT SELECT, INSERT, UPDATE ON anchors TO agora_product;
GRANT SELECT, INSERT ON save_invalidations TO agora_product;

-- Metadata reader: everything about a Save except its bytes.
GRANT SELECT ON saves, anchors, save_invalidations TO agora_custody_meta;

-- Payload transport (runtime-control): the bytes, and nothing else. It cannot read the metadata
-- that decides which Save is current, and it cannot publish an Anchor.
GRANT SELECT, INSERT, DELETE ON save_payloads TO agora_custody_payload;

-- S10 operational — catalogue revision publication ------------------------------------------------

-- The one selected revision of the trusted deployment policy (001 Intent, engine.md — Intent
-- authoring and revision selection). Workers read the SELECTION from here, never from whichever
-- catalogue happened to ship in their own container image (SESSION-A11): two workers on different
-- local files must both act on the selected revision or refuse, and a single row is what makes
-- "the selected one" a fact rather than a per-worker opinion.
CREATE TABLE selected_revision (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision_id text NOT NULL,
  revision_set jsonb NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now()
);

-- One publication of a new revision. `cursor_workstream_id` is how enumeration resumes after a
-- crash: targets are recorded in id order, and the sweep picks up from the last one it wrote
-- (ENGINE-014's "publication durably records affected Workstreams and schedules bounded
-- re-enqueue" — durably, so a controller restart owes the rest of the list, not a fresh start).
CREATE TABLE revision_publications (
  id uuid PRIMARY KEY,
  revision_id text NOT NULL,
  revision_set jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  -- enumerating -> enqueuing -> complete. Never skipped: a publication that has not finished
  -- enumerating cannot know which Workstreams it still owes a wake.
  state text NOT NULL DEFAULT 'enumerating' CHECK (state IN ('enumerating', 'enqueuing', 'complete')),
  cursor_workstream_id uuid NULL,
  completed_at timestamptz NULL
);

-- One row per affected Workstream, including Workstreams with no work row at all — an idle
-- Workstream whose harness digest was re-pinned is exactly the case a workset-only enumeration
-- would miss, and it is the case that matters.
CREATE TABLE publication_targets (
  publication_id uuid NOT NULL REFERENCES revision_publications(id),
  workstream_id uuid NOT NULL REFERENCES workstreams(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'enqueued')),
  enqueued_at timestamptz NULL,
  PRIMARY KEY (publication_id, workstream_id)
);

CREATE INDEX publication_targets_pending ON publication_targets (publication_id, workstream_id) WHERE state = 'pending';

REVOKE ALL ON selected_revision, revision_publications, publication_targets FROM PUBLIC;

-- Publication is an operator action taken through the product API, and the re-enqueue it schedules
-- writes the same work rows Intent authoring does — so the product role owns it. The engine reads
-- the selection to fence its own attempts and never publishes one.
GRANT SELECT, INSERT, UPDATE ON selected_revision TO agora_product;
GRANT SELECT, INSERT, UPDATE ON revision_publications TO agora_product;
GRANT SELECT, INSERT, UPDATE ON publication_targets TO agora_product;
GRANT SELECT ON selected_revision TO agora_engine;

-- S11 retention — a role that may delete recovery material, and nothing else ----------------------

-- Deleting a Save is not the control plane's authority: the control plane decides what to preserve
-- and what to publish, and a component that can both publish an Anchor and delete the Save under it
-- can quietly lose a recovery point. Retention runs as its own role, which can remove material and
-- cannot create or anchor any.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE ROLE agora_retention NOLOGIN';
  EXCEPTION
    WHEN duplicate_object OR unique_violation THEN
      NULL;
  END;
END;
$$;

GRANT SELECT, DELETE ON saves TO agora_retention;
GRANT SELECT, DELETE ON save_payloads TO agora_retention;
GRANT SELECT, DELETE ON save_invalidations TO agora_retention;
-- Anchors are READ ONLY here: retention must be able to see what an Anchor still needs, and must
-- never be able to unpublish one to make its own deletion legal.
GRANT SELECT ON anchors TO agora_retention;
GRANT SELECT ON sessions, workstreams TO agora_retention;

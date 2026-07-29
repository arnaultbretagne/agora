BEGIN;

CREATE SCHEMA IF NOT EXISTS product;
CREATE SCHEMA IF NOT EXISTS projection;
CREATE SCHEMA IF NOT EXISTS custody;

CREATE TYPE product.workstream_category AS ENUM ('discussion', 'invocation');
CREATE TYPE product.workstream_role AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE product.session_phase AS ENUM (
  'requested',
  'provisioning',
  'ready',
  'busy',
  'suspending',
  'suspended',
  'closing',
  'closed',
  'failed'
);
CREATE TYPE product.command_state AS ENUM (
  'accepted',
  'dispatching',
  'acknowledged',
  'unknown',
  'completed',
  'failed'
);
CREATE TYPE product.event_direction AS ENUM ('client_to_agent', 'agent_to_client');
CREATE TYPE product.rpc_kind AS ENUM ('request', 'response', 'notification');
CREATE TYPE product.event_purpose AS ENUM ('user', 'handoff', 'protocol');
CREATE TYPE product.ingest_mode AS ENUM ('live', 'load_replay', 'recovered');
CREATE TYPE projection.feed_operation AS ENUM ('upsert', 'remove', 'status', 'reset');

CREATE TABLE product.workstreams (
  id                 uuid PRIMARY KEY,
  category           product.workstream_category NOT NULL,
  title              text NOT NULL,
  title_source       text NOT NULL DEFAULT 'auto'
                     CHECK (title_source IN ('auto', 'user')),
  pinned             boolean NOT NULL DEFAULT false,
  last_event_seq     bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  deleting_at        timestamptz,
  deleted_at         timestamptz,
  CHECK (length(title) BETWEEN 1 AND 200),
  CHECK (deleted_at IS NULL OR deleting_at IS NOT NULL)
);

CREATE FUNCTION product.enforce_workstream_progress()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_event_seq < OLD.last_event_seq THEN
    RAISE EXCEPTION 'workstream last_event_seq cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workstreams_progress_guard
  BEFORE UPDATE ON product.workstreams
  FOR EACH ROW EXECUTE FUNCTION product.enforce_workstream_progress();

CREATE TABLE product.workstream_memberships (
  workstream_id  uuid NOT NULL
                 REFERENCES product.workstreams(id) ON DELETE CASCADE,
  principal_id  text NOT NULL,
  role          product.workstream_role NOT NULL,
  added_at      timestamptz NOT NULL,
  PRIMARY KEY (workstream_id, principal_id),
  CHECK (length(principal_id) BETWEEN 1 AND 300)
);

CREATE INDEX workstream_memberships_principal
  ON product.workstream_memberships(principal_id, workstream_id);

CREATE TABLE product.sessions (
  id                          uuid PRIMARY KEY,
  workstream_id               uuid NOT NULL
                              REFERENCES product.workstreams(id) ON DELETE CASCADE,
  ordinal                     integer NOT NULL CHECK (ordinal > 0),
  agent_id                    text NOT NULL,
  acp_session_id              text,
  phase                       product.session_phase NOT NULL DEFAULT 'requested',
  is_current                  boolean NOT NULL DEFAULT false,
  workspace_spec              jsonb NOT NULL CHECK (jsonb_typeof(workspace_spec) = 'object'),
  equipment_request           jsonb NOT NULL CHECK (jsonb_typeof(equipment_request) = 'object'),
  runtime_definition_version  text NOT NULL,
  capability_policy_version   text,
  capability_digest           bytea,
  acp_protocol_version        integer,
  negotiated_capabilities     jsonb,
  last_event_seq              bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  created_at                  timestamptz NOT NULL,
  bound_at                    timestamptz,
  closed_at                   timestamptz,
  failure_code                text,
  failure_detail              text,
  UNIQUE (workstream_id, ordinal),
  UNIQUE (id, workstream_id),
  UNIQUE (id, workstream_id, agent_id),
  CHECK (length(agent_id) BETWEEN 1 AND 120),
  CHECK (
    phase IN ('requested', 'provisioning', 'failed')
    OR acp_session_id IS NOT NULL
  ),
  CHECK ((acp_session_id IS NULL) = (bound_at IS NULL)),
  CHECK ((capability_policy_version IS NULL) = (capability_digest IS NULL)),
  CHECK (capability_digest IS NULL OR octet_length(capability_digest) = 32),
  CHECK (
    phase IN ('requested', 'failed')
    OR capability_digest IS NOT NULL
  ),
  CHECK (
    (phase = 'failed' AND failure_code IS NOT NULL)
    OR phase <> 'failed'
  )
);

CREATE FUNCTION product.enforce_session_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.acp_session_id IS NOT NULL
     AND (
       NEW.acp_session_id IS DISTINCT FROM OLD.acp_session_id
       OR NEW.bound_at IS DISTINCT FROM OLD.bound_at
     ) THEN
    RAISE EXCEPTION 'ACP Session binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.capability_digest IS NOT NULL
     AND (
       NEW.capability_digest IS DISTINCT FROM OLD.capability_digest
       OR NEW.capability_policy_version IS DISTINCT FROM OLD.capability_policy_version
     ) THEN
    RAISE EXCEPTION 'capability policy binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_event_seq < OLD.last_event_seq THEN
    RAISE EXCEPTION 'session last_event_seq cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_write_once_guard
  BEFORE UPDATE ON product.sessions
  FOR EACH ROW EXECUTE FUNCTION product.enforce_session_write_once();

CREATE UNIQUE INDEX sessions_agent_acp_session_id_unique
  ON product.sessions(agent_id, acp_session_id)
  WHERE acp_session_id IS NOT NULL;

CREATE UNIQUE INDEX sessions_one_current_per_workstream
  ON product.sessions(workstream_id)
  WHERE is_current;

CREATE INDEX sessions_workstream_order
  ON product.sessions(workstream_id, ordinal);

CREATE TABLE product.capability_grants (
  id                uuid PRIMARY KEY,
  session_id        uuid NOT NULL REFERENCES product.sessions(id) ON DELETE CASCADE,
  capability_id     text NOT NULL,
  access_level      text NOT NULL,
  constraints       jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(constraints) = 'object'),
  policy_version    text NOT NULL,
  resolved_at       timestamptz NOT NULL,
  UNIQUE (session_id, capability_id)
);

CREATE TABLE product.commands (
  id                   uuid PRIMARY KEY,
  workstream_id        uuid NOT NULL
                       REFERENCES product.workstreams(id) ON DELETE CASCADE,
  session_id           uuid,
  command_type         text NOT NULL,
  purpose              product.event_purpose,
  actor_kind           text NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  actor_id             text NOT NULL,
  idempotency_scope    text NOT NULL,
  idempotency_key      text NOT NULL,
  request              jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  state                product.command_state NOT NULL DEFAULT 'accepted',
  source_from_seq      bigint,
  source_through_seq   bigint,
  seed_policy_version  text,
  content_sha256       bytea,
  result_event_id      uuid,
  error_code           text,
  error_detail         text,
  accepted_at          timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  completed_at         timestamptz,
  UNIQUE (workstream_id, idempotency_scope, idempotency_key),
  UNIQUE (id, workstream_id),
  CHECK (length(actor_id) BETWEEN 1 AND 300),
  FOREIGN KEY (session_id, workstream_id)
    REFERENCES product.sessions(id, workstream_id) ON DELETE CASCADE,
  CHECK (
    (source_from_seq IS NULL AND source_through_seq IS NULL)
    OR (
      source_from_seq IS NOT NULL
      AND source_through_seq IS NOT NULL
      AND source_from_seq >= 0
      AND source_through_seq > source_from_seq
    )
  ),
  CHECK (
    purpose <> 'handoff'
    OR (
      session_id IS NOT NULL
      AND source_from_seq IS NOT NULL
      AND seed_policy_version IS NOT NULL
      AND content_sha256 IS NOT NULL
    )
  ),
  CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
  CHECK (
    (state = 'failed' AND error_code IS NOT NULL)
    OR state <> 'failed'
  )
);

CREATE INDEX commands_dispatch_queue
  ON product.commands(state, accepted_at)
  WHERE state IN ('accepted', 'dispatching');

CREATE TABLE product.workstream_events (
  id                    uuid PRIMARY KEY,
  workstream_id         uuid NOT NULL,
  workstream_seq        bigint NOT NULL CHECK (workstream_seq > 0),
  session_id            uuid NOT NULL,
  session_seq           bigint NOT NULL CHECK (session_seq > 0),
  direction             product.event_direction NOT NULL,
  rpc_kind              product.rpc_kind NOT NULL,
  method                text,
  rpc_id                jsonb,
  envelope              jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  command_id            uuid,
  causation_event_id    uuid,
  purpose               product.event_purpose NOT NULL DEFAULT 'protocol',
  entity_kind           text,
  entity_id             text,
  transport_observation_id text,
  ingest_mode           product.ingest_mode NOT NULL DEFAULT 'live',
  observed_at           timestamptz NOT NULL,
  UNIQUE (workstream_id, workstream_seq),
  UNIQUE (session_id, session_seq),
  UNIQUE (id, workstream_id),
  UNIQUE (id, workstream_id, workstream_seq),
  UNIQUE (id, workstream_id, session_id, workstream_seq),
  FOREIGN KEY (session_id, workstream_id)
    REFERENCES product.sessions(id, workstream_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id, workstream_id)
    REFERENCES product.commands(id, workstream_id),
  CHECK (
    (rpc_kind = 'response' AND method IS NULL)
    OR (rpc_kind <> 'response' AND method IS NOT NULL)
  )
);

ALTER TABLE product.commands
  ADD CONSTRAINT commands_result_event_fk
  FOREIGN KEY (result_event_id, workstream_id)
  REFERENCES product.workstream_events(id, workstream_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE product.workstream_events
  ADD CONSTRAINT workstream_events_causation_fk
  FOREIGN KEY (causation_event_id, workstream_id)
  REFERENCES product.workstream_events(id, workstream_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX workstream_events_session_entities
  ON product.workstream_events(session_id, entity_kind, entity_id)
  WHERE entity_id IS NOT NULL;

CREATE INDEX workstream_events_command
  ON product.workstream_events(command_id)
  WHERE command_id IS NOT NULL;

CREATE UNIQUE INDEX workstream_events_transport_observation
  ON product.workstream_events(session_id, direction, transport_observation_id)
  WHERE transport_observation_id IS NOT NULL;

CREATE TABLE product.journal_outbox (
  event_id             uuid PRIMARY KEY,
  workstream_id        uuid NOT NULL,
  workstream_seq       bigint NOT NULL CHECK (workstream_seq > 0),
  created_at           timestamptz NOT NULL,
  published_at         timestamptz,
  FOREIGN KEY (event_id, workstream_id, workstream_seq)
    REFERENCES product.workstream_events(id, workstream_id, workstream_seq) ON DELETE CASCADE
);

CREATE INDEX journal_outbox_unpublished
  ON product.journal_outbox(created_at, event_id)
  WHERE published_at IS NULL;

CREATE TABLE custody.snapshots (
  id                    uuid PRIMARY KEY,
  session_id            uuid NOT NULL
                        REFERENCES product.sessions(id) ON DELETE CASCADE,
  generation            bigint NOT NULL CHECK (generation > 0),
  capture_request_id    uuid NOT NULL,
  format_id             text NOT NULL,
  format_version        text NOT NULL,
  adapter_version       text NOT NULL,
  synced_through_seq    bigint NOT NULL CHECK (synced_through_seq >= 0),
  content_type          text NOT NULL DEFAULT 'application/octet-stream',
  payload               bytea NOT NULL,
  payload_sha256        bytea NOT NULL,
  size_bytes            bigint NOT NULL CHECK (size_bytes >= 0),
  created_at            timestamptz NOT NULL,
  invalidated_at        timestamptz,
  invalidation_reason   text,
  UNIQUE (session_id, generation),
  UNIQUE (session_id, capture_request_id),
  UNIQUE (id, session_id, synced_through_seq),
  CHECK (octet_length(payload_sha256) = 32),
  CHECK (octet_length(payload) = size_bytes),
  CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
);

CREATE FUNCTION custody.enforce_snapshot_invalidation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.invalidated_at IS NOT NULL
     AND (
       NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at
       OR NEW.invalidation_reason IS DISTINCT FROM OLD.invalidation_reason
     ) THEN
    RAISE EXCEPTION 'snapshot invalidation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER snapshots_invalidation_guard
  BEFORE UPDATE ON custody.snapshots
  FOR EACH ROW EXECUTE FUNCTION custody.enforce_snapshot_invalidation();

CREATE INDEX custody_snapshots_session_latest
  ON custody.snapshots(session_id, generation DESC);

CREATE TABLE product.agent_anchors (
  workstream_id          uuid NOT NULL,
  agent_id               text NOT NULL,
  session_id             uuid NOT NULL,
  custody_snapshot_id    uuid NOT NULL,
  synced_through_seq     bigint NOT NULL CHECK (synced_through_seq >= 0),
  updated_at             timestamptz NOT NULL,
  PRIMARY KEY (workstream_id, agent_id),
  FOREIGN KEY (session_id, workstream_id, agent_id)
    REFERENCES product.sessions(id, workstream_id, agent_id) ON DELETE CASCADE,
  FOREIGN KEY (custody_snapshot_id, session_id, synced_through_seq)
    REFERENCES custody.snapshots(id, session_id, synced_through_seq) ON DELETE RESTRICT
);

CREATE FUNCTION product.enforce_anchor_progress()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.synced_through_seq < OLD.synced_through_seq THEN
    RAISE EXCEPTION 'anchor watermark cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM product.workstreams
    WHERE id = NEW.workstream_id
      AND last_event_seq >= NEW.synced_through_seq
  ) THEN
    RAISE EXCEPTION 'anchor watermark exceeds Workstream head' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_anchors_progress_guard
  BEFORE INSERT OR UPDATE ON product.agent_anchors
  FOR EACH ROW EXECUTE FUNCTION product.enforce_anchor_progress();

CREATE TABLE projection.workstream_items (
  id                    uuid PRIMARY KEY,
  workstream_id         uuid NOT NULL
                        REFERENCES product.workstreams(id) ON DELETE CASCADE,
  session_id            uuid NOT NULL,
  item_kind             text NOT NULL,
  acp_entity_id         text,
  synthetic_entity_key  text,
  first_event_id        uuid NOT NULL,
  latest_event_id       uuid NOT NULL,
  first_workstream_seq  bigint NOT NULL CHECK (first_workstream_seq > 0),
  latest_workstream_seq bigint NOT NULL CHECK (latest_workstream_seq >= first_workstream_seq),
  current_value         jsonb NOT NULL,
  content_sha256        bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  updated_at            timestamptz NOT NULL,
  FOREIGN KEY (session_id, workstream_id)
    REFERENCES product.sessions(id, workstream_id) ON DELETE CASCADE,
  FOREIGN KEY (first_event_id, workstream_id, session_id, first_workstream_seq)
    REFERENCES product.workstream_events(id, workstream_id, session_id, workstream_seq)
    ON DELETE CASCADE,
  FOREIGN KEY (latest_event_id, workstream_id, session_id, latest_workstream_seq)
    REFERENCES product.workstream_events(id, workstream_id, session_id, workstream_seq)
    ON DELETE CASCADE,
  CHECK (
    (acp_entity_id IS NOT NULL AND synthetic_entity_key IS NULL)
    OR (acp_entity_id IS NULL AND synthetic_entity_key IS NOT NULL)
  )
);

CREATE UNIQUE INDEX workstream_items_acp_entity
  ON projection.workstream_items(session_id, item_kind, acp_entity_id)
  WHERE acp_entity_id IS NOT NULL;

CREATE UNIQUE INDEX workstream_items_synthetic_entity
  ON projection.workstream_items(session_id, item_kind, synthetic_entity_key)
  WHERE synthetic_entity_key IS NOT NULL;

CREATE INDEX workstream_items_feed_order
  ON projection.workstream_items(workstream_id, first_workstream_seq, id);

CREATE TABLE projection.projector_checkpoints (
  projector_name         text NOT NULL,
  workstream_id          uuid NOT NULL
                         REFERENCES product.workstreams(id) ON DELETE CASCADE,
  projector_version      text NOT NULL,
  through_workstream_seq bigint NOT NULL DEFAULT 0 CHECK (through_workstream_seq >= 0),
  last_event_id          uuid,
  updated_at             timestamptz NOT NULL,
  PRIMARY KEY (projector_name, workstream_id),
  FOREIGN KEY (last_event_id, workstream_id, through_workstream_seq)
    REFERENCES product.workstream_events(id, workstream_id, workstream_seq),
  CHECK (
    (through_workstream_seq = 0 AND last_event_id IS NULL)
    OR (through_workstream_seq > 0 AND last_event_id IS NOT NULL)
  )
);

CREATE TABLE projection.feed_events (
  position               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workstream_id          uuid NOT NULL
                         REFERENCES product.workstreams(id) ON DELETE CASCADE,
  through_workstream_seq bigint NOT NULL CHECK (through_workstream_seq >= 0),
  operation              projection.feed_operation NOT NULL,
  item_id                uuid,
  payload                jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at             timestamptz NOT NULL,
  CHECK (
    (operation IN ('upsert', 'remove') AND item_id IS NOT NULL)
    OR (operation IN ('status', 'reset') AND item_id IS NULL)
  )
);

CREATE INDEX feed_events_workstream_position
  ON projection.feed_events(workstream_id, position);

COMMIT;

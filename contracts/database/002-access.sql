BEGIN;

-- Deployment creates these NOLOGIN roles and grants them to workload login roles.
-- They are declared here to make the intended database boundary executable.
--
-- Roles are CLUSTER-global, not per-database, so two connections migrating two different fresh
-- databases on the same server race each other here. A check-then-create (`IF NOT EXISTS ... THEN
-- CREATE ROLE`) is not atomic across sessions: both can pass the check, and the loser gets
-- `duplicate key value violates unique constraint "pg_authid_rolname_index"` and fails the whole
-- migration. Found in CI, P13 — every package's test support creates a uniquely named disposable
-- database and migrates it, and `node --test` runs test FILES concurrently, so this fires whenever
-- the roles do not already exist on the server (a fresh CI Postgres; never a developer's long-lived
-- one, which is why it hid for so long).
--
-- Catching the conflict is the standard concurrency-safe idiom. Each CREATE gets its own
-- BEGIN/EXCEPTION block: a handler makes that block a subtransaction, so swallowing one conflict
-- leaves the outer migration transaction intact. Both SQLSTATEs are caught because the race surfaces
-- as `unique_violation` on the catalog index, while a plain sequential re-run raises
-- `duplicate_object`.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['agora_product', 'agora_projector', 'agora_custody_meta', 'agora_custody_runtime', 'agora_migrator']
  LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL; -- another session created it first, or it already existed; either way it now exists
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON SCHEMA product, projection, custody FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA product, projection, custody FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA product, projection, custody FROM PUBLIC;

GRANT USAGE ON SCHEMA product TO agora_product, agora_projector;
GRANT SELECT, INSERT, DELETE ON product.workstreams TO agora_product;
GRANT UPDATE (
  title,
  title_source,
  pinned,
  last_event_seq,
  updated_at,
  deleting_at,
  deleted_at
) ON product.workstreams TO agora_product;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON product.workstream_memberships TO agora_product;
GRANT SELECT, INSERT ON product.sessions TO agora_product;
GRANT UPDATE (
  acp_session_id,
  phase,
  is_current,
  capability_policy_version,
  capability_digest,
  acp_protocol_version,
  negotiated_capabilities,
  last_event_seq,
  bound_at,
  closed_at,
  failure_code,
  failure_detail
) ON product.sessions TO agora_product;
GRANT SELECT, INSERT ON product.commands TO agora_product;
GRANT UPDATE (
  state,
  result_event_id,
  error_code,
  error_detail,
  updated_at,
  completed_at
) ON product.commands TO agora_product;
GRANT SELECT, INSERT, DELETE ON product.agent_anchors TO agora_product;
GRANT UPDATE (
  session_id,
  custody_snapshot_id,
  synced_through_seq,
  updated_at
) ON product.agent_anchors TO agora_product;
GRANT SELECT, INSERT
  ON product.capability_grants
  TO agora_product;
GRANT SELECT, INSERT
  ON product.workstream_events
  TO agora_product;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON product.journal_outbox
  TO agora_product;
GRANT SELECT ON ALL TABLES IN SCHEMA product TO agora_projector;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA product TO agora_product;

GRANT USAGE ON SCHEMA projection TO agora_product, agora_projector;
GRANT SELECT ON ALL TABLES IN SCHEMA projection TO agora_product;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE
  ON ALL TABLES IN SCHEMA projection TO agora_projector;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA projection
  TO agora_product, agora_projector;

GRANT USAGE ON SCHEMA custody TO agora_custody_meta;
GRANT SELECT (
  id,
  session_id,
  generation,
  capture_request_id,
  format_id,
  format_version,
  adapter_version,
  synced_through_seq,
  content_type,
  payload_sha256,
  size_bytes,
  created_at,
  invalidated_at,
  invalidation_reason
) ON custody.snapshots TO agora_custody_meta;

GRANT USAGE ON SCHEMA product, custody TO agora_custody_runtime;
GRANT SELECT (id, workstream_id, agent_id, runtime_definition_version, phase)
  ON product.sessions TO agora_custody_runtime;
GRANT SELECT, INSERT, DELETE ON custody.snapshots TO agora_custody_runtime;
GRANT UPDATE (invalidated_at, invalidation_reason)
  ON custody.snapshots TO agora_custody_runtime;

COMMIT;

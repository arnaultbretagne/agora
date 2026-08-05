BEGIN;

-- docs/specs/10-equipment-and-broker.md "Persistence": Broker-private operational state — grant/
-- activation lifecycle, workload binding, OneCLI Agent mapping, encrypted upstream proxy authority.
-- Deliberately its OWN schema, never product.* (ADR 0011: separate trust zones/identities). No
-- deployable other than apps/broker is granted access to it.
CREATE SCHEMA IF NOT EXISTS broker;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_broker') THEN
    CREATE ROLE agora_broker NOLOGIN;
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA broker FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA broker FROM PUBLIC;

-- docs/specs/10 "Execution grant": bound to one Session ID and Agora Agent ID, cannot be upgraded
-- in place (UNIQUE session_id — a changed equipment set opens a new Session, docs/specs/10
-- "Equipment change"), idempotent by (session_id, request_id) so a retried issue call never
-- allocates a second grant.
CREATE TABLE broker.execution_grants (
  id                    uuid PRIMARY KEY,
  session_id            uuid NOT NULL,
  agent_id              text NOT NULL,
  principal_id          text NOT NULL,
  workstream_category   text NOT NULL CHECK (workstream_category IN ('discussion', 'invocation')),
  policy_version        text NOT NULL,
  capability_digest     bytea NOT NULL CHECK (octet_length(capability_digest) = 32),
  capabilities          jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
  mcp_servers           jsonb NOT NULL CHECK (jsonb_typeof(mcp_servers) = 'array'),
  onecli_identifier     text NOT NULL,
  request_id            uuid NOT NULL,
  state                 text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'revoked')),
  issued_at             timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (session_id),
  UNIQUE (session_id, request_id)
);

-- docs/specs/10 "Activation": binds grant + session_id + agent_id + workload_identity EXACTLY
-- ONCE. Idempotent by (grant_id, request_id); a request that tries to bind the SAME grant to a
-- DIFFERENT workload_identity is rejected by application logic (the UNIQUE(grant_id) alone can't
-- express "same identity" vs "different identity", so the repository checks before insert).
CREATE TABLE broker.grant_activations (
  id                    uuid PRIMARY KEY,
  grant_id              uuid NOT NULL REFERENCES broker.execution_grants(id) ON DELETE CASCADE,
  session_id            uuid NOT NULL,
  agent_id              text NOT NULL,
  workload_identity     text NOT NULL,
  request_id            uuid NOT NULL,
  activated_at          timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  UNIQUE (grant_id),
  UNIQUE (grant_id, request_id)
);

-- docs/specs/10 "One Session, one OneCLI Agent": onecli_identifier is the non-public operational
-- identifier derived from the Agora Session ID (never the Session ID itself, never exposed to the
-- Browser). Never reused across Sessions — deletion is terminal, not a state a Session returns from.
CREATE TABLE broker.onecli_agents (
  session_id            uuid PRIMARY KEY,
  onecli_identifier     text NOT NULL UNIQUE,
  onecli_agent_id       text,
  state                 text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deleted')),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL
);

-- docs/specs/10 "Secrets": the dedicated OneCLI Agent upstream bearer, encrypted, available only
-- to the access relay — never plaintext in a product table, never in an ACP envelope or log.
-- AES-256-GCM: encryption_nonce is the 12-byte GCM IV: the auth tag is stored appended to
-- encrypted_bearer's own ciphertext (standard Node crypto GCM output shape).
CREATE TABLE broker.upstream_authority (
  session_id            uuid PRIMARY KEY REFERENCES broker.onecli_agents(session_id) ON DELETE CASCADE,
  encrypted_bearer       bytea NOT NULL,
  encryption_nonce       bytea NOT NULL CHECK (octet_length(encryption_nonce) = 12),
  -- Captured from the same getContainerConfig call as the bearer — the access relay's ONLY source
  -- for which OneCLI gateway host:port to CONNECT through for this Session.
  gateway_url            text NOT NULL,
  rotated_at             timestamptz NOT NULL
);

-- docs/specs/11 "Audit": actor, Session, action class, decision, policy version, outcome — never
-- prompt/tool content, tokens or custody bytes. `detail` is operator-reviewed JSON that application
-- code MUST keep to safe identifiers/decisions only (enforced by the audit writer, not by SQL).
CREATE TABLE broker.security_audit (
  id                    uuid PRIMARY KEY,
  actor_kind            text NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  actor_id              text NOT NULL,
  session_id            uuid,
  action_class          text NOT NULL,
  decision              text NOT NULL,
  policy_version        text,
  detail                jsonb,
  created_at            timestamptz NOT NULL
);

CREATE INDEX security_audit_session ON broker.security_audit(session_id, created_at);

GRANT USAGE ON SCHEMA broker TO agora_broker;
GRANT SELECT, INSERT, UPDATE ON broker.execution_grants TO agora_broker;
GRANT SELECT, INSERT ON broker.grant_activations TO agora_broker;
GRANT SELECT, INSERT, UPDATE ON broker.onecli_agents TO agora_broker;
GRANT SELECT, INSERT, UPDATE, DELETE ON broker.upstream_authority TO agora_broker;
GRANT SELECT, INSERT ON broker.security_audit TO agora_broker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA broker TO agora_broker;

COMMIT;

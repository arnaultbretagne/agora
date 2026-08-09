BEGIN;

-- P12 — the two halves of "choose a model before anything is running".
--
-- docs/specs/04 is explicit that the Agent owns its own configuration vocabulary: "Agent-advertised
-- modes and configuration options are authoritative. The product MAY cache them for selection but
-- MUST validate changes against the current negotiated state". Both tables below are that cache and
-- that pending selection — neither is a product-owned model list, and neither becomes a `model` or
-- `effort` column on a Session (docs/specs/04 forbids exactly that).

-- What the harness last said it offers, per Agent AND per runtime definition version: a new image
-- may advertise a different set, and answering with the previous image's list would be a quietly
-- stale lie rather than a memo.
--
-- `options` holds the ACP `SessionConfigOption[]` array as advertised, with every `currentValue`
-- STRIPPED by the writer. A `currentValue` is one Session's state — usually somebody else's — and
-- has no meaning as a catalogue entry; keeping it would publish one operator's choice as another's
-- default. What a fresh Session starts on is the Agent's own business, and it says so in its own
-- `session/new` response.
CREATE TABLE product.agent_config_catalogue (
  agent_id                   text NOT NULL,
  runtime_definition_version text NOT NULL,
  options                    jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array'),
  observed_at                timestamptz NOT NULL,
  PRIMARY KEY (agent_id, runtime_definition_version)
);

-- The operator's desired configuration for one Session: durable intent, not harness truth.
--
-- It exists because the harness half of this pair only exists while a Pod does. A choice made
-- before the Runtime is materialized (in the composer) or after it has been reaped (a suspended
-- Session) has nowhere else to live, and losing it would mean the operator's model choice silently
-- reverting to the harness default on the next wake.
--
-- Kept after application rather than deleted: it is the desired state, so a resume re-asserts it.
-- `applied_at` is therefore a fact about the last successful `session/set_config_option`, not a
-- completion flag that retires the row.
CREATE TABLE product.session_config_intent (
  session_id   uuid NOT NULL REFERENCES product.sessions(id) ON DELETE CASCADE,
  option_id    text NOT NULL CHECK (length(option_id) BETWEEN 1 AND 200),
  -- ACP models a config option as a union: a `select` takes a value id, a `boolean` takes a state.
  -- Stored as jsonb so a boolean stays a boolean instead of becoming the string "true".
  value        jsonb NOT NULL CHECK (jsonb_typeof(value) IN ('string', 'boolean')),
  requested_at timestamptz NOT NULL,
  applied_at   timestamptz,
  PRIMARY KEY (session_id, option_id)
);

GRANT SELECT, INSERT, DELETE ON product.agent_config_catalogue TO agora_product;
GRANT UPDATE (options, observed_at) ON product.agent_config_catalogue TO agora_product;
GRANT SELECT, INSERT, DELETE ON product.session_config_intent TO agora_product;
GRANT UPDATE (value, requested_at, applied_at) ON product.session_config_intent TO agora_product;
GRANT SELECT ON product.agent_config_catalogue, product.session_config_intent TO agora_projector;

-- Backfill from the journal, so the Agents that have already run need no empty run to be usable.
--
-- Every ACP frame is journaled verbatim, so every `session/new` (and every
-- `session/set_config_option`) response this system has ever received is still here, carrying the
-- exact option set the harness advertised at the time. `method` is NULL on responses by contract
-- (`workstream_events`' own CHECK), so the frames are recognised by their shape — a `result` object
-- with a `configOptions` array — and attributed to an Agent through the Session that received them.
--
-- DISTINCT ON takes the newest such frame per (Agent, runtime definition version). `currentValue` is
-- stripped here for the same reason the writer strips it.
INSERT INTO product.agent_config_catalogue (agent_id, runtime_definition_version, options, observed_at)
SELECT DISTINCT ON (s.agent_id, s.runtime_definition_version)
  s.agent_id,
  s.runtime_definition_version,
  (
    SELECT coalesce(jsonb_agg(option - 'currentValue' ORDER BY ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(e.envelope -> 'result' -> 'configOptions')
      WITH ORDINALITY AS entry(option, ordinality)
  ),
  e.observed_at
FROM product.workstream_events e
JOIN product.sessions s ON s.id = e.session_id
WHERE e.rpc_kind = 'response'
  AND jsonb_typeof(e.envelope -> 'result' -> 'configOptions') = 'array'
  AND jsonb_array_length(e.envelope -> 'result' -> 'configOptions') > 0
ORDER BY s.agent_id, s.runtime_definition_version, e.observed_at DESC, e.workstream_seq DESC
ON CONFLICT (agent_id, runtime_definition_version) DO NOTHING;

COMMIT;

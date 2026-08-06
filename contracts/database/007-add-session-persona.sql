BEGIN;

-- The OLD channels-era system carried a per-run `agent` column — the "persona", passed to the
-- harness as `--agent <name>` (see /srv/agora/website/lib/supervisor.js's own spawn recipe). It is
-- part of what a user chooses when starting work, alongside the Agent itself, and the replacement
-- product surface has to offer the same choice.
--
-- Frozen at Session creation, exactly like `agent_id` and `runtime_definition_version`: the harness
-- receives it as a launch argument, so changing it means a different process, which means a
-- different Session (docs/specs/02 "One Session has one immutable workspace root specification and
-- one resolved capability envelope" — same reasoning). NULL means "no persona", the default the old
-- system expressed as an empty `--agent`.
--
-- Not added to `agora_product`'s column-scoped UPDATE grant (002-access.sql): nothing may mutate it
-- after insert. That is deliberate, and a change here would need its own migration.
ALTER TABLE product.sessions ADD COLUMN persona text;

ALTER TABLE product.sessions
  ADD CONSTRAINT sessions_persona_shape CHECK (persona IS NULL OR length(persona) BETWEEN 1 AND 120);

COMMIT;

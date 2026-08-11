-- The OneCLI Agent mapping records ONE fact: we have provisioned an Agent for this Session and
-- have not decommissioned it. Nothing else.
--
-- It used to carry a lifecycle state ('active' | 'suspended' | 'deleted') mirroring the Session's.
-- That state was a cache of something this database does not own — whether an Agent exists inside
-- OneCLI — and it was wrong in production the whole time it existed: measured 2026-08-11, 14 rows
-- said 'active', 29 said 'deleted', and the number of Agora Agents actually present in OneCLI was
-- ZERO. Trusting that cache is what left every suspended Session unresumable, and then what made
-- the first fix for it miss (it asked our own row instead of OneCLI).
--
-- Presence replaces it. Provisioning is idempotent and derived from the grant, which is the durable
-- statement of need: provision, decommission, and if the Session needs one again, provision again —
-- the same gesture. A row's existence is the only bit worth storing, and it is deleted rather than
-- tombstoned, so the table stops accumulating one dead row per Session that ever ran.

-- Tombstones first: 'deleted' and 'suspended' both mean "decommissioned", which under presence
-- semantics is "no row". Dropping the column without this would silently resurrect them into
-- "an Agent exists", which is the reaper's protection set — it would stop reclaiming real orphans.
DELETE FROM broker.onecli_agents WHERE state <> 'active';

ALTER TABLE broker.onecli_agents DROP COLUMN state;

-- `onecli_agent_id` goes with it: OneCLI issues a NEW internal id every time an identifier is
-- re-created (verified live 2026-08-11), so a stored id is stale the moment an Agent is
-- re-provisioned. The adapter has always resolved identifier -> id at call time; nothing read this.
ALTER TABLE broker.onecli_agents DROP COLUMN IF EXISTS onecli_agent_id;

COMMENT ON TABLE broker.onecli_agents IS
  'Presence only: a row means an Agent has been provisioned for this Session and not decommissioned. Never a lifecycle mirror of the Session — see 009 for why.';

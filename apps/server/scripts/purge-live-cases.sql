-- Removes every Workstream live-cases.ts created (owner c45e0000-…, its OWNER) and all that hangs from
-- them, in one transaction. Run as the database's owner once no claim is left, then restart the server.
BEGIN;
CREATE TEMP TABLE purged ON COMMIT DROP AS
  SELECT id FROM workstreams WHERE owner = 'c45e0000-0000-4000-8000-000000000000';
DELETE FROM thread WHERE workstream IN (SELECT id FROM purged);
DELETE FROM threads WHERE workstream IN (SELECT id FROM purged);
DELETE FROM objects WHERE workstream IN (SELECT id FROM purged);
DELETE FROM checkpoints WHERE workstream IN (SELECT id FROM purged);
DELETE FROM anchors WHERE workstream IN (SELECT id FROM purged);
DELETE FROM diagnostics WHERE workstream IN (SELECT id FROM purged);
DELETE FROM sessions WHERE workstream IN (SELECT id FROM purged);
DELETE FROM commands WHERE workstream IN (SELECT id FROM purged);
DELETE FROM entries WHERE workstream IN (SELECT id FROM purged);
DELETE FROM workstreams WHERE id IN (SELECT id FROM purged);
COMMIT;

-- One-off, 2026-11-01: the agents' folder's 33 Workstreams into the tree (docs/specs/log.md, "Sub-streams").
-- The 24 team members go under the lead their Prefect run names — a member's id is uuid5 of "<run>/<member>"
-- (apps/flows/agora.py), a lead the run's `lead_workstream` — and become the person's; the 9 others, judge
-- replays and access checks, become the person's roots. Their list rows are dropped: the server writes them
-- again at its next start, each in its list, its lead's counting it ("The list", back-filling).
-- Run as the database's owner, once the schema has the line's columns:
--   psql -v apply=false -f map-team-substreams.sql   (shows what changes, keeps nothing)
--   psql -v apply=true  -f map-team-substreams.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE members(id uuid PRIMARY KEY, lead uuid NOT NULL) ON COMMIT DROP;
INSERT INTO members(id, lead) VALUES
  ('befd8bc0-f406-5042-bcfc-c7c16db961bd', '5f333cc8-c205-462f-adb0-7bba2c615f13'), -- dev-1, run 20f795d9
  ('c4079f31-f7e0-5000-ace4-52b47ea99c0d', '5f333cc8-c205-462f-adb0-7bba2c615f13'), -- judge-1, run 20f795d9
  ('d0301c05-45df-5876-b431-2e4d13c68a5b', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- dev-1, run 2f42be87
  ('6615dfc8-6683-5500-adce-6716400607e1', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-1, run 2f42be87
  ('962a1f1f-6b73-562d-986a-f246cfc17aa1', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-10, run 2f42be87
  ('7e734506-9c96-5861-acdf-fbd94f575f7b', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-11, run 2f42be87
  ('3b309d3b-394a-5087-9ce8-c671221e92a3', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-12, run 2f42be87
  ('0e7f7278-78fc-508a-b62e-2e90f391cf32', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-2, run 2f42be87
  ('892e4223-8bc5-559e-855f-c8f2ffa1eb3c', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-3, run 2f42be87
  ('e4e88d02-b33c-5c64-a195-085fad940cc9', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-4, run 2f42be87
  ('d39a693e-8785-5940-936b-1793ba4aeb92', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-5, run 2f42be87
  ('1f87c81b-724b-5d23-aa29-af8f8e00859b', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-6, run 2f42be87
  ('ebf47c18-7b68-5a23-ba37-b3de19b60141', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-7, run 2f42be87
  ('2da52726-0c2b-5fd8-9b2a-77148bee2783', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-8, run 2f42be87
  ('cd380d9c-00d7-521c-8f45-0bb315bb47af', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- judge-9, run 2f42be87
  ('ce2b12f3-942a-578c-a75c-35f0db807354', 'f9bf8ee3-3ee3-4fa6-aff6-1978399a44de'), -- sre-1, run 2f42be87
  ('71a66e65-e842-590e-8285-3f95b2665d98', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- dev-1, run 2f437cd3
  ('2dbe5fc6-dc8a-5c23-b987-030f8c5815c9', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- judge-1, run 2f437cd3
  ('a20bd56b-a898-5178-80ec-901fa6dbdf93', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- judge-2, run 2f437cd3
  ('0c1953a1-7747-5ef3-b00f-310a4ca2971b', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- judge-3, run 2f437cd3
  ('b80e2aad-380c-5c31-b512-9c7e67330d06', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- judge-4, run 2f437cd3
  ('f98683c1-2771-5626-aaec-5533ff420058', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- judge-5, run 2f437cd3
  ('0f386256-973f-55d0-a7d2-c2a25b57f323', '907ac476-f1d3-4427-b2e8-e01d93232478'), -- judge-6, run 2f437cd3
  ('668f4dc5-22e9-5571-8c9f-6157bde67910', '907ac476-f1d3-4427-b2e8-e01d93232478'); -- sre-1, run 2f437cd3
CREATE TEMP TABLE others(id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO others(id) VALUES
  ('04c9a8fd-4385-5c1e-a50c-ba7c1ae1dba5'),
  ('228b19eb-f8c0-5925-9d25-6f2efd568201'),
  ('342807aa-85fa-5a55-82ed-afe31a3c9661'),
  ('516d695a-1b45-5ee5-be61-b2302b849961'),
  ('6171e50e-054f-5e2d-9951-c1f5b6f5d618'),
  ('65faa1c3-5c41-5113-96c3-a956005304d7'),
  ('91e27398-5490-5b29-bc48-a39337cafd2d'),
  ('bc2fbb49-7c80-5fd2-b206-98ed4b45eb5c'),
  ('db2d338a-058e-59cf-8c4b-64fff15a0158');
-- As found: every member and other in the agents' folder, a root; every lead the person's, a root. Else nothing moves.
DO $$ BEGIN
  IF (SELECT count(*) FROM members m JOIN workstreams w ON w.id = m.id WHERE w.owner = '999d43c4-028e-5d3e-97d1-dfaae8b3e3dc' AND w.parent IS NULL) <> 24
    OR (SELECT count(*) FROM others o JOIN workstreams w ON w.id = o.id WHERE w.owner = '999d43c4-028e-5d3e-97d1-dfaae8b3e3dc' AND w.parent IS NULL) <> 9
    OR (SELECT count(*) FROM members m JOIN workstreams l ON l.id = m.lead WHERE l.owner = 'c18ec77d-a9b8-508e-9777-165b93aa7648' AND l.parent IS NULL) <> 24
  THEN RAISE EXCEPTION 'not as found on 2026-11-01: nothing moved'; END IF;
END $$;
UPDATE workstreams w SET parent = m.lead, root = m.lead, depth = 1, owner = 'c18ec77d-a9b8-508e-9777-165b93aa7648' FROM members m WHERE w.id = m.id;
UPDATE workstreams w SET owner = 'c18ec77d-a9b8-508e-9777-165b93aa7648' FROM others o WHERE w.id = o.id;
DELETE FROM listings WHERE workstream IN (SELECT id FROM members UNION SELECT id FROM others);
SELECT l.id AS lead, count(*) AS members FROM members m JOIN workstreams l ON l.id = m.lead GROUP BY l.id ORDER BY 2 DESC;
SELECT owner, count(*) FROM workstreams WHERE owner IN ('c18ec77d-a9b8-508e-9777-165b93aa7648', '999d43c4-028e-5d3e-97d1-dfaae8b3e3dc') GROUP BY owner;
\if :apply
COMMIT;
\else
ROLLBACK;
\endif

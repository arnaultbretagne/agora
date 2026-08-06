BEGIN;

-- Found live, P11: activations-repository.ts's own idempotency check does
-- `SELECT ... FROM broker.grant_activations WHERE grant_id = $1 FOR UPDATE` before inserting —
-- Postgres requires the UPDATE privilege on a table to acquire a row lock via FOR UPDATE, even
-- though no UPDATE statement is ever actually issued against this table. 003-broker.sql's own
-- original GRANT only had SELECT, INSERT — every real grant activation attempt failed live with
-- "permission denied for table grant_activations" (a Postgres wire-protocol error, not something
-- the fake OneCLI test adapter's own tests, which never touch a real Postgres role, could catch).
-- 003-broker.sql itself is fixed too, for any FUTURE fresh deployment; this migration is the
-- follow-up for a database that already ran the old grant.
GRANT UPDATE ON broker.grant_activations TO agora_broker;

COMMIT;

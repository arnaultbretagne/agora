BEGIN;

-- Found live, P11 (real end-to-end test, not just automated tests): 002-access.sql's own
-- `GRANT UPDATE (...)` on product.sessions is COLUMN-scoped, and 005-add-session-execution-grant
-- -ref.sql's new execution_grant_ref column was never added to that list — every real
-- provisionSessionAndPrompt call failed live with "permission denied for table sessions" the
-- moment `bindExecutionGrantRef` tried to persist the Broker's real grantRef. The automated test
-- suite never caught this because it runs against `agora_test_web_*` databases created fresh from
-- a superuser/maintenance connection (test/support.ts), never through the real `agora_product`
-- role's own restricted grants the way the live cluster's `DATABASE_URL` does.
--
-- 002-access.sql itself is fixed too, for any FUTURE fresh deployment; this migration is the
-- follow-up for a database that already ran the old grant.
GRANT UPDATE (execution_grant_ref) ON product.sessions TO agora_product;

COMMIT;

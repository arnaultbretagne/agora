-- The Broker decommissions a Session's OneCLI Agent by DELETING its mapping row (migration 009:
-- presence, not tombstones). Its role was granted SELECT/INSERT/UPDATE only, which was correct
-- while decommissioning meant writing state = 'deleted' and is not any more.
--
-- Found live, and only live: every test runs as the owner, so the suite was green while a real
-- suspend answered 500 `permission denied for table onecli_agents` — silently, because the caller
-- deliberately swallows cleanup failures. `constraints-and-roles.test.ts` now pins this privilege
-- so the next change to it fails a test instead of a production suspend.
GRANT DELETE ON broker.onecli_agents TO agora_broker;

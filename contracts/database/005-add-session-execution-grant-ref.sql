BEGIN;

-- Found live, P11: apps/web never actually called the Broker's real grant-issuance endpoint —
-- `orchestration.ts` used a fixed `FAKE_EXECUTION_GRANT_REF` left over from before the Broker
-- (P08) existed. Wiring the real `POST /v1/execution-grants` call means apps/web must be able to
-- resume a Session later (docs/specs/03 "Resume") WITHOUT re-issuing a second grant for the same
-- Session — `broker.execution_grants.session_id` is UNIQUE (one grant per Session, ever); a
-- resume must instead RENEW the existing grant (`POST /v1/execution-grants/{id}/renew`), which
-- needs the original grantRef back. The Broker's own schema is deliberately private (ADR 0011:
-- separate trust zones) — no deployable other than apps/broker may read `broker.*` — so the
-- grantRef this product-schema Session obtained at issuance time is recorded here, write-once,
-- exactly like `capability_policy_version`/`capability_digest` already are (bindCapabilities).
ALTER TABLE product.sessions ADD COLUMN execution_grant_ref text;

COMMIT;

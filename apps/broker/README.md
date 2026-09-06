# apps/broker — OneCLI verification (P8)

Per `docs/plans/S07-broker-onecli-capabilities.md`, "Before coding": results of standing up and
probing the pinned OneCLI before writing the client. This was **not** a fresh instance — it is the
project's existing self-hosted OneCLI (`contracts/k8s`-equivalent in `infra-k8s`, namespace
`agora-onecli`), which is also the credential authority the currently-deployed (pre-rewrite) broker
uses. Verification was read-mostly against `GET`s already used in production, plus one bounded,
fully cleaned-up round trip: `createAgent` → `getAgentGrants` → `getEffectiveCredentials` →
`getContainerConfig` → `deleteAgent` (`204`, confirmed gone), under a test-scoped identifier
(`agora-s7-verify-test`) never reused by any real Session. No production Agent, grant or secret was
read, written or removed.

- **Version**: `1.45.0` (`GET /v1/health` → `{"status":"ok","version":"1.45.0",...}`), image digest
  pinned in `infra-k8s/apps/agora-onecli/onecli.yaml`
  (`ghcr.io/onecli/onecli@sha256:d0177458b1f9ecece4abbe9abb6c5f925475357c1734f50a675d83a2ef9c8687`).
- **Auth**: `Authorization: Bearer <project API key>` (prefix `oc_…`) on the management API
  (port `10254`); distinct from the per-Agent gateway proxy bearer (`aoc_…`, port `10255`, HTTP
  Basic — see field-findings §3.2, unchanged).
- **Full OpenAPI reference recovered live**: `https://onecli.sh/docs/openapi.yaml` (the docs site's
  own `/docs/api-reference` 404 error message on an unrecognized route names this URL). This is the
  authoritative endpoint list `packages/policy` and `apps/broker/src/onecli/client.ts` are built
  against — prefer it over reconstructing shapes from field-findings' 2026-07/08 notes, which
  predate it and disagree on at least one point below.

## Endpoints relied upon

| Need | Endpoint |
|---|---|
| List agents (stable ids) | `GET /agents` |
| Create an Agent | `POST /agents` `{name, identifier}` |
| Delete an Agent | `DELETE /agents/{agentId}` |
| Attached grants (the writable intent) | `GET /agents/{agentId}/grants` |
| Effective credentials (intent + org policy applied) | `GET /agents/{agentId}/effective-credentials` |
| Attach/detach a secret | `PUT` / `DELETE /agents/{agentId}/grants/secrets/{secretId}` |
| Attach/detach a connection | `PUT` / `DELETE /agents/{agentId}/grants/connections/{connectionId}` |
| Container/env wiring for a launch | `GET /container-config?agent={identifier}` |
| Ordered egress allow/block per provider | `GET/POST /apps/{provider}/blocklist`, `PATCH/DELETE .../blocklist/{ruleId}` |

## Verified live, 2026-09-06

- **Agent creation is not idempotent.** A second `POST /agents` with the same `identifier` answers
  `409 {"error":{"message":"An agent with this identifier already exists",...}}` — it does **not**
  return the existing Agent. Recovery after a lost response is: list `GET /agents` and filter by
  `identifier` client-side (no get-by-identifier endpoint exists, only get-by-id and
  `GET /agents/default`). **Confirms P5/P8**: `create_pod`'s crash-then-retry pattern in
  `apps/runtime-control/src/owner-api.ts` (discover-by-deterministic-name on `409`) is the right
  shape for `apps/broker`'s Agent creation too.
- **Grant mutations carry no version/ETag and are not conditional.** `PUT`/`DELETE` on one
  `{agentId}/grants/{secrets|connections}/{id}` sub-resource takes effect immediately (no
  draft/publish step for per-Agent grants — that workflow exists only for *organization* policy
  rules, a separate resource this slice does not touch) and is naturally idempotent at the HTTP
  level: a repeated `PUT` with the same body reapplies the same grant, a repeated `DELETE` answers
  `404` on the second call, which the owner-request layer (S5 protocol, not OneCLI) treats as
  already-satisfied. `deleteAgent` behaves the same way — confirmed live (`204` then `404`).
- **`GET /agents` includes each Agent's `accessToken`** (the `aoc_…` gateway bearer) in this
  version. This **disagrees with field-findings §3.1** ("`listAgents` returns identifiers and
  creation times only, no token"), which was recorded against 1.43.3/1.45.0 in 2026-07/08 — either
  that note was against a differently-configured instance or the behavior changed. Treat the live
  OpenAPI schema (`AgentWithGrantsSummary`/`Agent`) as current truth; the private store
  (`private-store.ts`) must still be the only place this token is retained past the one read that
  provisions it, regardless of how many other responses happen to carry it.
- **`getContainerConfig` confirmed field-findings §3.2 exactly**: the proxy URL's password is the
  gateway bearer (`http://x:<aoc_…>@onecli.agora-onecli.svc.cluster.local:10255`, username `x` is a
  dummy), `GIT_HTTP_PROXY_AUTHMETHOD: basic`, `NODE_EXTRA_CA_CERTS` points at a mounted CA path.
  Also returns `warnings` (e.g. "No Anthropic credentials configured…") for an ungranted Agent —
  worth surfacing rather than discarding.

## Not yet exercised

Everything requiring a live harness Pod or the relay in front of it — the through-tunnel negative
test (findings §3.2: "the gateway answers 200 to every CONNECT"), Basic-vs-Bearer auth regression,
tunnel termination on REVOKE, and P10's relay identity mechanism against this cluster's actual CNI —
is deferred to Step 5 of the work plan and is not covered by this P8 pass.

## Residual log exposure decision

Not yet made. `infra-k8s/apps/agora-onecli/onecli.yaml` currently pins `LOG_LEVEL: info` for the
existing (pre-rewrite) deployment; field-findings §3.2 says stdout carries full URLs including
query strings regardless of level for at least one observed case. Carry this decision forward to
Step 7 (deployment) rather than deciding it here from a read-only pass.

# P13 — OneCLI credential-grant migration and relay-owned egress

> Architecture-remodel notice: this completed implementation work uses the previous per-Session
> runtime mapping. Its grant/relay split remains valid, but Pod-scoped OneCLI Agent ownership under
> ADR 0009 requires a follow-up implementation plan.

- **Status:** in_progress (code, tests, specs and ADR complete; production digest bump awaiting the
  operator's merge of the coupled infra-k8s change — see "Cutover state" below)
- **Dependencies:** P08 (Broker), P11 (hardening/deploy)
- **Primary paths:** `apps/broker/src/{route-policy,relay,onecli-real,onecli-adapter,grant-service}.ts`,
  `docs/specs/{10,11}-*.md`, `infra-k8s/apps/agora-onecli/onecli.yaml`
- **Decision of record:** [ADR 0009](../docs/adr/0009-onecli-grant-authority.md)

## Why this plan exists (read first)

Agora's Broker enforces provider network egress by publishing, per Session, a first-match OneCLI
rule set of host allows ending in `block *` (`route-policy.ts` → `onecli-real.ts#publishRoutePolicy`
→ `/v1/policy/rules` + `/v1/policy/publish`). A 2026-08-09 study of the OneCLI source (repo
`onecli/onecli`, read at the exact release tags) and the operator's live instance proved this rests
on a **removed API** and a model that **no longer supports egress deny**:

- Agora runs OneCLI **1.43.3**, pinned by digest in `infra-k8s/apps/agora-onecli/onecli.yaml`
  (`ghcr.io/onecli/onecli@sha256:7a4fef94...`). **1.44.0** (PR #462) retired project-scope
  `/v1/policy/*` writes to `410 Gone` and made per-Agent **grants** the only writer of project
  access. The digest pin is the sole reason `publishRoutePolicy` still works today.
- The ≥1.44 model has **no `kind:network` grant and no project `block *`**: grants attach
  connections/secrets only; the project Default Rule is seeded `allow` always and is "not a posture
  dial"; network/org rules are Enterprise (`ee/`). There is no OSS successor to the egress model of
  specs 10/11.
- The current code does not even deliver the isolation the specs claim: all live Agents run
  `secretMode: all` and every rule has `identities: []`, so any Session can inject any project
  secret. `ensureSelectiveAgent` cannot make an Agent selective (`CreateAgentInput` has no
  `secretMode`).

Per ADR 0009: **OneCLI becomes a credential firewall** (per-Agent grants decide *which credential*
is injected), and **Agora owns network egress at the Broker relay** (deny-by-default host allow-list
enforced on CONNECT). This plan builds that, then upgrades OneCLI deliberately.

## Facts you must not rediscover

**Reaching the live instance** (operator cluster; `dev` has passwordless sudo):
```
sudo -n k0s kubectl exec -i -n agora-onecli deploy/onecli -c onecli -- node   # pipe a Node script to STDIN
```
The API listens on `127.0.0.1:10254` inside the Pod, unauthenticated from localhost. **Never
`JSON.parse` and print `/v1/agents` raw — its rows contain `accessToken` (`aoc_…`) in cleartext.**
Redact `aoc_[a-f0-9]+` before any output.

**Verification oracles** (use these to prove behavior, do not trust rule listings alone):
- `GET /v1/agents/{id}/effective-credentials` → `{mode, secrets:[{name,host,status}], connections:[…]}`.
  `status` is `usable` | `blocked` — this is the ground truth for "can this Agent inject this
  credential". A selective Agent with no matching grant returns an empty/blocked set (verified live).
- `GET /v1/connections/{id}/effective-agents` → which Agents can reach a connection (read-only).

**OneCLI 1.43.3 (current) — what works and what is already gone:**
- `PATCH /v1/agents/{id}/secret-mode` body `{"mode":"all"|"selective"}` — works. Selective =
  inject only credentials named by an enabled allow rule whose `identities` explicitly lists the
  Agent; `identities:[]` never injects for a selective Agent.
- `/v1/policy/rules` (GET/POST/DELETE) + `/v1/policy/publish` — works (what Agora uses now).
- `/v1/rules` — already `410` on 1.43.3.
- `CreateAgentInput` = `{name, identifier, parentIdentifier?}`; `parentIdentifier` only inherits
  `secretMode` at creation, nothing else.

**OneCLI ≥1.44 grants API (migration target):**
- `GET  /v1/agents/{agentId}/grants` — attached connections (per-tool) and secrets.
- `PUT  /v1/agents/{agentId}/grants/connections/{connectionId}` — body `{"access":"full"}` or
  `{"access":"custom","allow":[toolIds…],"ask":[toolIds…]}` (unnamed tools blocked; `422` if the
  two lists together name zero tools, or a tool is in both).
- `DELETE /v1/agents/{agentId}/grants/connections/{connectionId}` → `204`.
- `PUT  /v1/agents/{agentId}/grants/secrets/{secretId}` — assign-only, **no body** (secrets are
  all-or-nothing).
- `DELETE /v1/agents/{agentId}/grants/secrets/{secretId}`.
- `GET  /v1/agents?include=grants-summary` — Agent list with per-Agent grant summaries.
- Grants **take effect immediately, no publish step**. A freshly created Agent has **zero** access
  (fail-closed). On ≥1.44: project `/v1/policy/*` writes, `PATCH …/secret-mode`, and per-Agent
  assignment lists all answer `410 Gone` naming their replacement.

**Vendored SDK:** the version in `node_modules/@onecli-sh/sdk` (1.43.x era) exposes
`listAgents/createAgent/ensureAgent/getEffectiveCredentials/getConnectionAgentAccess` but **no
grant-attach methods**. Call grants via raw REST using the existing `restJson` helper in
`onecli-real.ts`. Re-check the SDK surface if/when you bump it at upgrade time.

**Current code touch points:**
- `route-policy.ts` — `compileRoutePolicy(activeGrants): {routeSetVersion, routes:[{action,host}]}`;
  hardcoded `PINNED_AGENT_ROUTE_SETS` and `CAPABILITY_ROUTE_HOSTS`. Resolves but **discards**
  `fact.constraints` and `accessLevel`.
- `grant-service.ts` — calls `compileRoutePolicy` + `publishRoutePolicy` at issue (~`:204`) and
  revoke (~`:377`); publish-then-verify via `getPublishedGeneration()`.
- `onecli-adapter.ts` — interface `OneCliControlAdapter`: `publishRoutePolicy`,
  `ensureSelectiveAgent`, `rotateAgentAuthority`, `deleteAgent`, `getPublishedGeneration`,
  `getContainerConfig`.
- `relay.ts` — `:89-123` parses CONNECT `host:port` with `activation`/`grant`/`sessionId` resolved;
  `deny(deps, socket, code, reason)` helper; `bridgeThroughGateway(...)` at `:181` opens the upstream
  tunnel. **This is where the egress gate goes: after host parse, before bridge.**
- `ActiveGrantSummary` (`grants-repository.ts`) — `{id, agentId, onecliIdentifier, capabilities}`.

## Target architecture (the finalized design)

```
Session Runtime Pod ── CONNECT host:443 ─▶ Broker relay ──(host on Session allow-list?)──▶ OneCLI gateway ──▶ provider
                                              │  yes → bridge          no → 403, never bridged
                                              └── egress decision: Agora's, per Session (route-policy.ts)

Broker grant issue ─▶ ensure per-Session OneCLI Agent ─▶ attach ONLY resolved credentials via grants ─▶ (OneCLI injects only those)
                                                          credential decision: OneCLI's, per Agent
```

1. **Credential selection = OneCLI grants, per Session Agent.** On grant issue, ensure the Session's
   Agent (create is unchanged), then attach exactly the resolved capabilities:
   - each capability's provider **secret** → `PUT …/grants/secrets/{secretId}`;
   - each capability's **connection** (e.g. `github-app`) → `PUT …/grants/connections/{connectionId}`
     with `{"access":"custom",…}` mapping `read`/`propose` to tool allow/ask lists.
   Resolve `secretId`/`connectionId` at runtime by name/provider (do not hardcode instance ids).
   A new Agent is zero-access, so isolation is correct by construction. No project-policy publish.
2. **Network egress = relay allow-list, per Session, deny-by-default.** `route-policy.ts` is
   retargeted to compile a **host allow-list for the relay** (not OneCLI rules), consuming
   `fact.constraints` + `accessLevel` (e.g. `github/read` → `github.com` + `api.github.com`). The
   relay looks up the Session's compiled allow-list and refuses to bridge a non-listed host.
3. **Revocation/expiry = relay activation binding** (already per-Session) + `deleteAgent` for the
   Agent's credential authority. No global republish anywhere.
4. **`git clone` works:** the allow-list includes `github.com` (the git-over-HTTPS host), not only
   `api.github.com`.

## Deliverables

- A grants-based credential adapter replacing `publishRoutePolicy` for credential selection.
- A relay egress gate enforcing the per-Session host allow-list before bridging.
- `route-policy.ts` retargeted to compile the relay allow-list, honoring constraints + access level.
- Orphan-Agent reaper (reconcile OneCLI Agents against active grants).
- Specs 10 & 11 amended to the ADR 0009 model.
- Deliberate OneCLI upgrade to a pinned ≥1.45 digest, after the above is proven on 1.43.3-compatible
  paths where possible and on a staging ≥1.45 instance for the grants paths.

## Tasks

- [x] **Prove the grants path on a staging ≥1.45 instance** before touching Broker code. Done
  2026-08-09 against a throwaway `agora-onecli-staging` deployment of **1.45.0**
  (`sha256:d0177458b1f9ecece4abbe9abb6c5f925475357c1734f50a675d83a2ef9c8687`, the newest tag
  published). The transcript is retained in
  [parked ADR 0015](../docs/adr/parked/0015-onecli-credential-firewall-egress-at-relay.md): a fresh Agent is
  `{mode:"selective",secrets:[],connections:[]}`; `PUT …/grants/secrets/{id}` flips exactly that
  secret to `usable`; a second Agent granted the other secret shows the inverse and neither moves
  when the other changes; `DELETE` → `204` → empty. `/v1/policy/{rules,publish,last-publish}`,
  `/v1/rules` and `PATCH …/secret-mode` all answer `410 Gone`.
- [x] **Retarget `route-policy.ts`** — `compileSessionEgressAllowList(grant)` now emits a sorted,
  deduplicated per-Session host set with no `block *` concept. Keyed by `capabilityId/accessLevel`
  so an unreviewed access level cannot inherit another's hosts, and `fact.constraints` is genuinely
  consumed: an unreviewed constraint key now fails closed instead of being silently discarded (it
  used to be resolved, persisted, then dropped — granting UNSCOPED access to a scoped request).
  `github/*` allow-lists `github.com` and `raw.githubusercontent.com` alongside `api.github.com`,
  taken from the host patterns of OneCLI's own `github-app` tool catalogue.
- [x] **Add the relay egress gate** — `relay.ts` recompiles the allow-list from the grant row it has
  already loaded and denies `403 egress_not_allowed` before `readUpstreamAuthority`, so no upstream
  socket exists for a denied CONNECT. Recompiling per CONNECT rather than caching at activation was
  a deliberate change from the plan's sketch: the compiler is a pure function of (Agent,
  capabilities), so there is nothing to cache, no invalidation to get wrong, and no compiled list
  that can outlive the grant that produced it. Tests assert the 403, the audit code, and that the
  dial spy recorded zero upstream dials.
- [x] **Add a grants credential adapter** — `syncCredentialGrants` / `getEffectiveCredentials` /
  `listAgents` on `OneCliControlAdapter`, implemented over raw `restJson` in `onecli-real.ts` and
  faithfully doubled in `onecli-fake.ts`. Credentials are named by OneCLI **type/provider** and
  resolved to instance ids at call time. The sync CONVERGES (detaches anything unwanted), so a
  re-issue can never leave a stale credential attached. New `credential-policy.ts` holds the
  reviewed mapping.
- [x] **Rewire `grant-service.ts`** — issue now ensures the Agent, attaches grants, verifies them,
  and only then pulls the container config; revoke just deletes the Agent. Both `publishRoutePolicy`
  and `getPublishedGeneration` are gone from the adapter entirely. `verifyGrantsEffective` compares
  `effective-credentials` against the intended set in BOTH directions — missing or extra is a
  refusal.
- [x] **Orphan-Agent reaper** — `onecli-agent-reaper.ts`, at Broker startup and hourly. Reconciles
  against `broker.onecli_agents` rows rather than active grants: a suspended Session legitimately
  outlives its 30-minute grant (docs/specs/10), so reaping on "no active grant" would delete every
  suspended-but-resumable Session's Agent. Only `sagt-` Agents outside a 15-minute grace window are
  candidates, so the operator's own Agents and in-flight issues are never touched.
- [x] **Amend specs 10 & 11** — "Route-policy compilation" is replaced by "Egress-policy
  compilation" (relay, deny-by-default) plus "Credential-grant compilation" (OneCLI, per Agent);
  spec 11's `block *` clause is rewritten, including the requirement that a negative egress test
  assert the refusal at the relay.
- [ ] **Upgrade OneCLI** to the pinned 1.45.0 digest in `infra-k8s/apps/agora-onecli/onecli.yaml`.
  Prepared, not merged — see "Cutover state".
- [x] **Record the OneCLI grant and relay decision.** The replacement decision is ADR 0009.

## Evidence

**Real adapter against live OneCLI 1.45.0** (2026-08-09) — `createOnecliSdkAdapter` itself, not the
test double, driven against the staging instance through a port-forward. A faithful double can only
assert the contract; this asserts the wire format:

```
fresh agent effective-credentials: {"mode":"selective","secrets":[],"connections":[]}
compiled desired (claude-code):    {"credentialSetVersion":"credentials-v1","secretTypes":["anthropic"],…}
compiled desired (codex):          {"credentialSetVersion":"credentials-v1","secretTypes":["openai"],…}
effective (claude): {"secrets":[{"id":"2f682b5e-…","status":"usable"}],"connections":[]}
effective (codex):  {"secrets":[{"id":"1ade8733-…","status":"usable"}],"connections":[]}
ISOLATION OK: each Agent holds exactly its own provider credential
after re-sync onto a different desired set: {"secrets":[{"id":"1ade8733-…","status":"usable"}]}
CONVERGENCE OK: the previous credential was detached, not left behind
after detach-all: {"mode":"selective","secrets":[],"connections":[]}
listAgents returns identifier+createdAt only; no `aoc_` token in its output
```

`ensureSelectiveAgent` (SDK `ensureAgent`) still works unchanged on 1.45.0, so the vendored
1.43.x-era `@onecli-sh/sdk@3.0.0` does not have to be bumped for this cutover — only the grant calls
needed raw REST.

**Automated suite:** `npm test` green, including 75 Broker tests. New/rewritten coverage:
`route-policy.test.ts` (per-Session allow-list, exact host matching, constraint fail-closed),
`credential-policy.test.ts` (per-Agent isolation, read/propose tool split, no `ask`),
`onecli-agent-reaper.test.ts` (orphan reaped, live and suspended Sessions never reaped, grace
window, list failure is hard), plus grants-effect, extra-credential and egress-gate cases in
`grant-service.test.ts` / `relay.test.ts`.

## Cutover state (2026-08-09)

The OneCLI upgrade and the Broker deploy are **one coupled cutover**, and neither half works with
the other's old half — measured, not assumed:

- old Broker + OneCLI ≥1.44: `publishRoutePolicy` gets `410 Gone`, every issue fails;
- new Broker + OneCLI 1.43.3: `GET /v1/agents/{id}/grants` is `404` on 1.43.3 (verified live against
  the operator's own instance), so `syncCredentialGrants` fails and every issue fails.

They must therefore land in a single infra-k8s change, which is prepared as a PR rather than pushed:
the digest bump only takes effect when the operator merges it, and flux deploys from `main`.

The `[grant-conversion]` boot converter runs on first start of the upgraded instance. The Broker
does not trust its outcome: `verifyGrantsEffective` refuses to issue for any Agent whose effective
credential set is larger than what Agora attached, which is exactly the "materialized the whole
pool" failure mode the converter could produce — and the reaper deletes the 15 live orphan Agents
that would otherwise carry converted grants forward.

## Required tests / evidence gates

- Grant isolation (live): a Session Agent with a Claude grant shows Anthropic `usable`, Codex
  `blocked` in `effective-credentials`; a Codex Session Agent shows the inverse. Capture transcripts.
- Egress deny (unit + live): an unlisted host CONNECT returns 403 at the relay and no upstream socket
  is opened; a listed host bridges. `git clone https://github.com/<repo>` succeeds only when the
  Session has `github` equipment (so `github.com` is listed).
- No global state: issuing/revoking one Session's grant changes nothing observable for another
  Session's Agent (no shared republish).
- Reaper: after a Session ends, its `sagt-*` Agent is gone within one reap cycle; a live Session's
  Agent is never reaped.
- Upgrade: on the ≥1.45 instance, `/v1/policy/*` project writes are absent from Agora's code path;
  Broker issue/revoke works entirely through grants + relay.

## Rollout / version posture

Build and prove on the current pinned 1.43.3 where the path is version-independent (relay gate,
route-policy retarget, reaper), and on a **separate staging ≥1.45 instance** for the grants adapter.
Only then bump the production digest. Do not allow OneCLI to auto-upgrade before the grants adapter
exists: ≥1.44 breaks `publishRoutePolicy` and would take the Broker's issue path down.

## Out of scope

- Path/method-level egress rules (Enterprise-only in OneCLI; host-level is the deliberate ceiling).
- OneCLI Enterprise / org-policy console.
- Any change to ACP, custody, or the Session lifecycle.

## Operational follow-ups (from the study, not blocking)

- The `default` OneCLI Agent's `accessToken` leaked into a 2026-08-09 conversation; rotate it with
  `POST /v1/agents/{id}/regenerate-token`. Agora does not reference `default`, so rotation is safe.

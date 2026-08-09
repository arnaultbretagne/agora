# P13 — OneCLI credential-grant migration and relay-owned egress

- **Status:** pending
- **Dependencies:** P08 (Broker), P11 (hardening/deploy)
- **Primary paths:** `apps/broker/src/{route-policy,relay,onecli-real,onecli-adapter,grant-service}.ts`,
  `docs/specs/{10,11}-*.md`, `infra-k8s/apps/agora-onecli/onecli.yaml`
- **Decision of record:** [ADR 0015](../docs/adr/0015-onecli-credential-firewall-egress-at-relay.md)

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

Per ADR 0015: **OneCLI becomes a credential firewall** (per-Agent grants decide *which credential*
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
- Specs 10 & 11 amended to the ADR 0015 model.
- Deliberate OneCLI upgrade to a pinned ≥1.45 digest, after the above is proven on 1.43.3-compatible
  paths where possible and on a staging ≥1.45 instance for the grants paths.

## Tasks

- [ ] **Prove the grants path on a staging ≥1.45 instance** before touching Broker code: create an
  Agent, attach one secret grant, confirm `effective-credentials` flips that secret to `usable` while
  a second secret stays `blocked`; detach → `blocked`. Record the transcript as evidence.
- [ ] **Retarget `route-policy.ts`** to emit a per-Session host allow-list (drop the terminal
  `block *` "route" concept; the relay is deny-by-default intrinsically). Consume `fact.constraints`
  and `accessLevel`. Add `github.com` alongside `api.github.com` for the `github` capability. Keep it
  a pure function of active grants (deterministic, sorted, deduped). Update `route-policy.test.ts`.
- [ ] **Add the relay egress gate** in `relay.ts`: after host parse (`:89-123`), look up the
  Session's allow-list and `deny(…, 403, 'egress_not_allowed')` if the host is absent, before
  `bridgeThroughGateway`. Wire the allow-list source (compiled at grant activation, keyed by
  Session/activation). Add unit tests: allowed host bridges, unlisted host 403s and never dials
  upstream.
- [ ] **Add a grants credential adapter** to `onecli-adapter.ts` / `onecli-real.ts`: methods to
  attach/detach secret and connection grants by (agentId, credential) via raw `restJson`. Resolve
  credential ids by name/provider (`GET /v1/secrets`, `GET /v1/connections`).
- [ ] **Rewire `grant-service.ts`**: on issue, ensure Agent + attach resolved grants (replace the
  `compileRoutePolicy`+`publishRoutePolicy` call at `~:204` with grant attach + relay allow-list
  compile); on revoke, detach/delete (replace `~:377`). Remove the project-policy publish-then-verify;
  add a grants-effect verification via `effective-credentials`.
- [ ] **Orphan-Agent reaper**: reconcile `GET /v1/agents` against active grants; `deleteAgent` the
  unmatched `sagt-*`. Run on a schedule and at Broker startup. (There are 15 orphans live today; this
  is NOT the `apps/web/src/idle-reaper.ts`, which suspends Agora Sessions, a different object.)
- [ ] **Amend specs 10 & 11**: replace "explicit allows + `block *` in OneCLI" with "credential
  grants in OneCLI; deny-by-default host egress at the relay". Cross-reference ADR 0015.
- [ ] **Upgrade OneCLI** to a pinned ≥1.45 digest in `infra-k8s/apps/agora-onecli/onecli.yaml`;
  verify its release/source provenance (this also closes the open P11 provenance task). The boot
  converter will materialize existing `all`-mode Agents' pools as explicit grants — verify each
  Session Agent ends with exactly its intended grants, not the whole pool.
- [ ] **Flip ADR 0015 to Accepted** once the above lands and specs are amended.

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

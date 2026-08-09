# ADR 0015 — OneCLI is a credential firewall; Agora owns network egress at the relay

- **Status:** Proposed
- **Date:** 2026-08-09
- **Amends:** ADR 0010, ADR 0011, ADR 0014 (the OneCLI-enforced-egress clauses only)

## Context

ADR 0010/0011/0014 and specs 10/11 place network egress enforcement inside OneCLI: the Broker
compiles, per Session, a first-match rule set of explicit host allows terminated by `block *`, and
publishes it to OneCLI's project-scoped policy. `apps/broker/src/route-policy.ts` +
`onecli-real.ts#publishRoutePolicy` implement exactly that against `/v1/policy/rules` +
`/v1/policy/publish`.

A source-and-live study on 2026-08-09 (repo `onecli/onecli`, read at the exact tags; live probes
against the operator's instance) established two facts that invalidate that placement:

1. **The project-policy authoring surface is being removed.** Agora runs **1.43.3** (pinned by
   digest). **1.44.0** (PR #462, "agent grants — per-agent credential access replaces the project
   policy page") retires project-scope `/v1/policy/*` writes to `410 Gone` and makes **agent grants**
   the single writer of project access. On 1.43.3 the twin `/v1/rules` already answers `410`; the
   public onecli.sh docs already describe the ≥1.44 model, not ours. Our digest pin is the only
   reason `publishRoutePolicy` still works.

2. **The ≥1.44 OSS model has no network egress deny.** Grants attach **connections and secrets**
   only (`PUT /v1/agents/{id}/grants/connections|secrets/{id}`); they compile to rules whose targets
   are `connection`/`secret`/`app` — **never `kind: network`**. The new-project Default Rule is
   seeded `allow` **always** and is documented as "not a posture dial"
   (`policy-oss-cutover.ts`); project-scope network rules are gone and organization rules live in
   `ee/` (Enterprise). **In OSS ≥1.44 there is no supported way to express a terminal `block *`.**

Separately, the study found the current implementation does not deliver the isolation the ADRs
claim: all 17 live OneCLI Agents run `secretMode: all` and every published rule has
`identities: []`, so any Session's Agent can inject any project secret. The "Per-Agent credential
selection: PASS" spike gate reflects a manual dashboard test, not the code path Agora runs — because
`CreateAgentInput` carries no `secretMode`, `ensureSelectiveAgent` cannot actually create a selective
Agent (verified: selective mode is a separate `PATCH /v1/agents/{id}/secret-mode` on 1.43.3, dropped
in favor of grants in ≥1.44).

## Decision

Split the two concerns OneCLI conflates for us, and place each where the supported product keeps it:

**OneCLI is a credential firewall.** It decides *which provider credential is injected for which
Agent*, and nothing about which hosts an Agent may reach. Per-Session isolation is expressed with the
**grants** model (≥1.44): the Broker creates one Agent per Session (grants make a fresh Agent
zero-access and fail-closed, so per-Session Agents are cheap and correct now — no longer the churn
liability they were under project-rule authoring) and attaches exactly the Session's resolved
credentials via `PUT /v1/agents/{id}/grants/{connections|secrets}/{id}`. No `route-policy` rules, no
project-policy publish, no `block *` in OneCLI.

**Agora owns network egress at the Broker relay.** `apps/broker/src/relay.ts` already terminates the
Session's authenticated CONNECT and parses `host:port` with the Session and grant resolved
(`relay.ts:89-123`). The relay becomes the deny-by-default egress point: it refuses to bridge a
CONNECT whose host is not on the Session's compiled allow-list, before opening the upstream tunnel.
This is genuine enforcement (a refused CONNECT never reaches a provider), unlike the P11 trap where
*probing* a CONNECT status told nothing — here Agora is the server, not the prober.

`route-policy.ts` is retargeted from "compile OneCLI rules" to "compile the per-Session host
allow-list the relay enforces", and finally consumes `fact.constraints` and `accessLevel`, which the
current compiler resolves, persists, then discards.

**Version posture.** Stay pinned to a known OneCLI (1.43.3 today) until the grants adapter and the
relay egress gate are built and proven; then upgrade deliberately to a pinned ≥1.45 digest. Do not
let OneCLI auto-upgrade: ≥1.44 breaks `publishRoutePolicy` outright.

## Consequences

- Egress granularity at the relay is **host-level** (SNI/CONNECT authority). Path/method-level egress
  rules are an Enterprise-only OneCLI feature and are explicitly out of scope; if ever required they
  are a separate decision, not a reason to keep egress in OneCLI OSS.
- Revocation and expiry of egress move fully to the relay's activation binding, where per-Session
  revocation already lives — this was the only real argument for per-Session OneCLI identities, and
  the relay serves it directly.
- The OneCLI upgrade to ≥1.45 becomes a credential-only migration: same per-Session Agents, grants
  replacing `secretMode`, no egress behavior to port.
- Specs 10 and 11 are amended by the executing plan (P13): the "explicit allows + `block *`
  in OneCLI" language is replaced by "credential grants in OneCLI; deny-by-default egress at the
  relay".
- ADR 0014's "OneCLI ... enforce provider-route policy" clause is narrowed to credential injection
  and selection; route/egress policy is Agora's at the relay.

## Alternatives rejected

- **Buy OneCLI Enterprise for org policy rules:** reintroduces network egress into a paid,
  separately-scoped surface for a host-level allow-list Agora can enforce itself at a boundary it
  already owns.
- **Freeze OneCLI at 1.43.3 forever to keep `publishRoutePolicy`:** builds the product on a
  removed API and an unmaintained version; the model is already gone upstream.
- **Keep per-Session OneCLI Agents but publish per-identity rules on 1.43.3:** technically possible
  (the engine matches `identities:[{type:'agent'}]`), but it is the exact churn-per-Session model the
  vendor retired in 1.44, and it dies at the next upgrade.
- **Enforce egress with a Kubernetes NetworkPolicy per Session:** cannot express provider hostnames
  (L7/SNI), and per-Session Pod-level policy churn is heavier than an allow-list check at a relay the
  traffic already transits.

## Governing specs

- [Equipment and Broker](../specs/10-equipment-and-broker.md)
- [Security](../specs/11-security.md)

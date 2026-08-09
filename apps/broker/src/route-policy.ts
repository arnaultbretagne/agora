import type { CapabilityFact } from '@agora/equipment-policy'

export const EGRESS_SET_VERSION = 'egress-v1'

/**
 * WHO ENFORCES WHAT, AFTER ADR 0015 (read this before concluding "the allowlist is broken"):
 *
 * This file no longer compiles OneCLI rules. OneCLI is a credential firewall — per-Agent grants
 * decide WHICH provider credential is injected (`credential-policy.ts`) — and **Agora owns network
 * egress at its own relay**. What this file compiles is the per-Session host allow-list that
 * `relay.ts` enforces on CONNECT, before it ever opens the upstream tunnel.
 *
 * Why the move (verified live 2026-08-09, both against the pinned 1.43.3 instance and a staging
 * 1.45.0 one): OneCLI 1.44.0 retired project-scope `/v1/policy/*` writes to `410 Gone` — measured
 * on 1.45.0, every one of `GET|POST /v1/policy/rules`, `POST /v1/policy/publish`,
 * `GET /v1/policy/last-publish` and `GET /v1/rules` answers 410 naming grants as the replacement —
 * and the ≥1.44 grant model has no `kind:network` target and no project `block *` at all. The old
 * "explicit allows + terminal block, published to OneCLI" model has no OSS successor upstream.
 *
 * The enforcement point is therefore genuinely different now, and strictly better observable: a
 * host that is not on this list is refused by Agora's own relay with `403 egress_not_allowed` and
 * NO upstream socket is ever opened. Under the old model the gateway answered `200 OK` to every
 * CONNECT and enforced inside the tunnel, so a CONNECT status line told you nothing — the trap P11
 * fell into. `broker.security_audit`'s `relay.connect`/`denied` rows with code
 * `egress_not_allowed` are now a real egress-decision trail, not merely a tunnel trail.
 *
 * Granularity is host-level (the CONNECT authority), deliberately: path/method-level egress is an
 * OneCLI Enterprise feature and ADR 0015 fixes host-level as the ceiling.
 */

export interface PinnedAgentRouteSet {
  readonly agentId: string
  readonly hosts: readonly string[]
}

/**
 * docs/specs/10 "Route-policy compilation": "narrow OpenAI/ChatGPT hosts to the endpoints required
 * by the pinned Codex runtime" — reviewed, per-Agent, independent of any Session's equipment. Kept
 * inline here rather than added to `AgentRuntimeDefinition` (packages/agent-registry): that schema
 * is a P01-era external contract (contracts/schemas/agent-runtime.schema.json) shared by every
 * plan, and route review is a Broker-only concern, not something the wider registry consumes.
 * `fake-agent`/`fake-agent-b` are the identities apps/web's fake driver registers (P05/P07) — real
 * automated tests exercise this exact table, not a placeholder.
 */
export const PINNED_AGENT_ROUTE_SETS: readonly PinnedAgentRouteSet[] = [
  { agentId: 'claude-code', hosts: ['api.anthropic.com', 'statsig.anthropic.com'] },
  // `auth.openai.com` found missing live (2026-08-05, P10 credential-linking spike): ChatGPT
  // subscription auth periodically refreshes its access_token via `POST auth.openai.com/oauth/token`
  // — without it in the allow list, the very first token refresh gets denied, breaking a session
  // that started working fine (the initial request succeeds on the token minted at link time; only
  // the refresh path was missing).
  { agentId: 'codex', hosts: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'] },
  { agentId: 'fake-agent', hosts: ['fake-agent.internal.test'] },
  { agentId: 'fake-agent-b', hosts: ['fake-agent.internal.test'] },
]

/**
 * docs/specs/10 route-policy compilation item 2: "explicit allow rules derived from approved
 * capability facts **and constraints**". Keyed by `capabilityId/accessLevel`, not by capability
 * alone: an access level nobody reviewed must not inherit another one's hosts by accident, so
 * `github/read` and `github/propose` are separate reviewed entries even where they resolve to the
 * same host set (writes to GitHub go to the same hosts reads do).
 *
 * `vault` has no external provider host at any access level — Agents reach it exclusively through
 * Broker's own MCP shim (`packages/equipment-policy/src/mcp-servers.ts`), never through the OneCLI
 * gateway — so it derives zero hosts.
 *
 * The GitHub host set is not guesswork: it is exactly the set of `hostPattern`s OneCLI's own
 * `github-app` permission catalogue attaches to the tools `credential-policy.ts` grants (read at
 * the 1.45.0 image, 2026-08-09) — `github.com` for git-over-HTTPS (`git_clone`/`git_push`),
 * `api.github.com` for the REST/GraphQL tools, `raw.githubusercontent.com` for `read_raw_content`.
 * `github.com` being present is what makes `git clone https://github.com/…` work at all; an
 * `api.github.com`-only list (what this file compiled before P13) silently broke it.
 */
const CAPABILITY_ROUTE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'vault/read': [],
  'vault/read-write': [],
  'github/read': ['api.github.com', 'github.com', 'raw.githubusercontent.com'],
  'github/propose': ['api.github.com', 'github.com', 'raw.githubusercontent.com'],
}

/**
 * The reviewed constraint vocabulary, per capability. Deliberately empty for every capability
 * today, and deliberately NOT ignored: before P13 the compiler resolved `fact.constraints`,
 * persisted them on the grant, and then discarded them — so an equipment request carrying a
 * `scope` was silently granted UNSCOPED access, the exact opposite of what the caller asked for.
 * Failing closed on an unreviewed constraint key is the honest behavior while no constraint
 * vocabulary has been reviewed; adding one (e.g. `repositories` for `github`, which OneCLI's own
 * grant API can carry as connection `resources`) is a reviewed change to this table plus the
 * matching `credential-policy.ts` entry, not something a request can assert into existence.
 */
const CAPABILITY_REVIEWED_CONSTRAINTS: Readonly<Record<string, readonly string[]>> = {
  vault: [],
  github: [],
}

export class RoutePolicyError extends Error {
  constructor(
    readonly code: 'unknown_pinned_agent' | 'unknown_capability_host_mapping' | 'unreviewed_capability_constraint' | 'empty_policy',
    message: string,
  ) {
    super(message)
    this.name = 'RoutePolicyError'
  }
}

/** The per-Session egress decision the relay enforces. Deny-by-default is intrinsic: a host absent
 * from `hosts` is refused, so there is no terminal `block *` entry to express (and no ordering to
 * get wrong — this is a set, not a first-match rule list). */
export interface CompiledEgressAllowList {
  readonly egressSetVersion: string
  readonly hosts: readonly string[]
}

/** Everything the compiler needs about one Session's grant. Structurally satisfied by both
 * `ActiveGrantSummary` and `ExecutionGrant`, so the relay can compile straight from the grant row
 * it already loaded on every CONNECT. */
export interface EgressPolicySubject {
  readonly agentId: string
  readonly capabilities: readonly CapabilityFact[]
}

function pinnedHostsFor(agentId: string): readonly string[] {
  const pinned = PINNED_AGENT_ROUTE_SETS.find((set) => set.agentId === agentId)
  if (!pinned) throw new RoutePolicyError('unknown_pinned_agent', `no reviewed pinned route set for Agent '${agentId}' — refusing to compile an unreviewed allow list`)
  return pinned.hosts
}

function capabilityHostsFor(fact: CapabilityFact): readonly string[] {
  const key = `${fact.capabilityId}/${fact.accessLevel}`
  const hosts = CAPABILITY_ROUTE_HOSTS[key]
  if (hosts === undefined) {
    throw new RoutePolicyError('unknown_capability_host_mapping', `no reviewed route mapping for '${key}' — refusing to compile an unreviewed allow list`)
  }
  const reviewedConstraints = CAPABILITY_REVIEWED_CONSTRAINTS[fact.capabilityId] ?? []
  for (const constraintKey of Object.keys(fact.constraints)) {
    if (!reviewedConstraints.includes(constraintKey)) {
      throw new RoutePolicyError(
        'unreviewed_capability_constraint',
        `capability '${fact.capabilityId}' carries constraint '${constraintKey}', which no reviewed policy can enforce — refusing to grant unscoped access in its place`,
      )
    }
  }
  return hosts
}

/**
 * docs/specs/10 "Route-policy compilation", as amended by ADR 0015: the deterministic union of
 * (1) the Session Agent's pinned route set and (2) the hosts derived from this Session's own
 * approved capability facts, access levels and constraints. Deduplicated and sorted, so the same
 * grant always compiles to the same list regardless of capability order.
 *
 * A pure function of the grant alone — no shared/global state, no cache, no publish. The relay
 * recompiles it on every CONNECT from the grant row it has already read, which is why revoking or
 * expiring one Session's grant can never change what another Session may reach (required test:
 * "No global state"), and why there is no window in which a stale compiled list outlives the grant
 * that produced it.
 *
 * A Session whose Agent needs no external host and holds no host-deriving capability legitimately
 * compiles to an EMPTY list — that is total egress denial for that Session, not a malformed
 * policy. What is never tolerated is an empty or `*` host STRING inside the list.
 */
export function compileSessionEgressAllowList(grant: EgressPolicySubject): CompiledEgressAllowList {
  const hosts = new Set<string>()

  for (const host of pinnedHostsFor(grant.agentId)) {
    if (!host || host === '*') throw new RoutePolicyError('empty_policy', 'pinned route set contains an empty or wildcard host')
    hosts.add(host.toLowerCase())
  }
  for (const fact of grant.capabilities) {
    for (const host of capabilityHostsFor(fact)) {
      if (!host || host === '*') throw new RoutePolicyError('empty_policy', 'capability route mapping contains an empty or wildcard host')
      hosts.add(host.toLowerCase())
    }
  }

  return { egressSetVersion: EGRESS_SET_VERSION, hosts: [...hosts].sort() }
}

/**
 * The relay's own membership test. Exact authority match, case-insensitive (DNS names are
 * case-insensitive; a CONNECT line may carry any casing). Deliberately NOT a suffix or wildcard
 * match: `evil-api.github.com.attacker.test` must not pass because `api.github.com` is listed, and
 * no reviewed entry in this file is a pattern.
 */
export function isEgressHostAllowed(allowList: CompiledEgressAllowList, host: string): boolean {
  return allowList.hosts.includes(host.toLowerCase())
}

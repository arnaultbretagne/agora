import type { CapabilityFact } from '@agora/equipment-policy'
import type { PublishedRoute } from './onecli-adapter.js'
import type { ActiveGrantSummary } from './grants-repository.js'

export const ROUTE_SET_VERSION = 'routes-v1'

/**
 * HOW ONECLI ACTUALLY ENFORCES WHAT THIS FILE COMPILES (verified live against a real self-hosted
 * OneCLI 1.43.3, P11 — worth reading before ever concluding "the allowlist is broken"):
 *
 * The gateway ALWAYS answers `HTTP/1.1 200 OK` to a CONNECT, for every host, allow-listed or not.
 * It then MITMs the TLS (the peer certificate is issued by "OneCLI Local Gateway CA" — the
 * operator-pinned CA mounted into every Session Runtime Pod is what makes that acceptable to the
 * Agent) and evaluates these rules against the HTTP REQUEST INSIDE the tunnel. OneCLI's own docs
 * say it plainly: "a transparent proxy that intercepts outgoing HTTP requests, checks them against
 * your rules". A blocked host therefore looks like:
 *
 *     CONNECT evil.example.com:443  ->  200 OK        (tunnel established, tells you NOTHING)
 *     GET / (inside the tunnel)     ->  403 Forbidden (this is the enforcement point)
 *
 * Measured live, same Agent, same credential:
 *     api.anthropic.com                   -> 404 from the real upstream (allow-listed, reached it)
 *     http-intake.logs.us5.datadoghq.com  -> 403 (blocked by the terminal `block *`)
 *     example.com                         -> 403 (blocked by the terminal `block *`)
 *
 * Consequence for debugging: a probe that stops at the CONNECT status line cannot distinguish
 * "allowed" from "blocked", and `broker.security_audit`'s own `relay.connect`/`approved` rows mean
 * only that the TUNNEL was bridged — never that the traffic was permitted. P11 briefly and wrongly
 * concluded from exactly that signal that egress enforcement had never worked at all. Any future
 * check must send a real request through the established tunnel.
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
  // — without it in the allow list, the very first token refresh gets blocked by the catch-all,
  // breaking a session that started working fine (the initial request succeeds on the token minted
  // at link time; only the refresh path was missing).
  { agentId: 'codex', hosts: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'] },
  { agentId: 'fake-agent', hosts: ['fake-agent.internal.test'] },
  { agentId: 'fake-agent-b', hosts: ['fake-agent.internal.test'] },
]

/**
 * docs/specs/10 route-policy compilation item 2: "explicit allow rules derived from approved
 * capability facts". `vault` has no external provider host — Agents reach it exclusively through
 * Broker's own MCP shim (`packages/equipment-policy/src/mcp-servers.ts`), never through the OneCLI
 * gateway — so it derives zero routes. `github` is modeled as needing a direct OneCLI-mediated
 * route to the GitHub API. This mapping is illustrative (docs/specs/10 does not enumerate a
 * concrete table), matching how `packages/equipment-policy`'s own "operator rule" is illustrative.
 */
const CAPABILITY_ROUTE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  vault: [],
  github: ['api.github.com'],
}

export class RoutePolicyError extends Error {
  constructor(
    readonly code: 'unknown_pinned_agent' | 'unknown_capability_host_mapping' | 'empty_policy',
    message: string,
  ) {
    super(message)
    this.name = 'RoutePolicyError'
  }
}

export interface CompiledRoutePolicy {
  readonly routeSetVersion: string
  readonly routes: readonly PublishedRoute[]
}

function pinnedHostsFor(agentId: string): readonly string[] {
  const pinned = PINNED_AGENT_ROUTE_SETS.find((set) => set.agentId === agentId)
  if (!pinned) throw new RoutePolicyError('unknown_pinned_agent', `no reviewed pinned route set for Agent '${agentId}' — refusing to compile an unreviewed allow list`)
  return pinned.hosts
}

function capabilityHostsFor(fact: CapabilityFact): readonly string[] {
  const hosts = CAPABILITY_ROUTE_HOSTS[fact.capabilityId]
  if (hosts === undefined) {
    throw new RoutePolicyError('unknown_capability_host_mapping', `no reviewed route mapping for capability '${fact.capabilityId}' — refusing to compile an unreviewed allow list`)
  }
  return hosts
}

/**
 * docs/specs/10 "Route-policy compilation": deterministic union of (1) every currently-active
 * grant's pinned Agent route set, then (2) every currently-active grant's capability-derived
 * hosts, then (3) one final explicit `block *`. Deterministic ordering: hosts are deduplicated and
 * sorted, so the SAME set of active grants always compiles to the SAME route list regardless of
 * issue/iteration order (required test: "route allow/block ordering and terminal-block
 * enforcement").
 *
 * Reject-empty (docs/specs/10 "reject empty/malformed targets"): a policy with zero allow rules
 * still compiles (an idle Broker with no active grants legitimately has none), but never omits the
 * terminal block, and never emits an allow for `'*'` or an empty host string.
 */
export function compileRoutePolicy(activeGrants: readonly ActiveGrantSummary[]): CompiledRoutePolicy {
  const pinnedHosts = new Set<string>()
  const capabilityHosts = new Set<string>()

  for (const grant of activeGrants) {
    for (const host of pinnedHostsFor(grant.agentId)) {
      if (!host) throw new RoutePolicyError('empty_policy', 'pinned route set contains an empty host')
      pinnedHosts.add(host)
    }
    for (const fact of grant.capabilities) {
      for (const host of capabilityHostsFor(fact)) {
        if (!host) throw new RoutePolicyError('empty_policy', 'capability route mapping contains an empty host')
        capabilityHosts.add(host)
      }
    }
  }

  // Item 2 must never shadow or precede item 1 — hosts already covered by the pinned set are not duplicated.
  for (const host of pinnedHosts) capabilityHosts.delete(host)

  const routes: PublishedRoute[] = [
    ...[...pinnedHosts].sort().map((host) => ({ action: 'allow' as const, host })),
    ...[...capabilityHosts].sort().map((host) => ({ action: 'allow' as const, host })),
    { action: 'block' as const, host: '*' },
  ]

  return { routeSetVersion: ROUTE_SET_VERSION, routes }
}

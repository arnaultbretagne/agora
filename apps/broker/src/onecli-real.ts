import { OneCLI } from '@onecli-sh/sdk'
import type {
  OneCliAgentHandle,
  OneCliContainerConfig,
  OneCliControlAdapter,
  PublishedRoute,
  RoutePolicyPublishResult,
} from './onecli-adapter.js'
import { OneCliUnavailableError } from './onecli-adapter.js'

/**
 * SDK- and REST-backed implementation, wired against `@onecli-sh/sdk@3.0.0`'s exposed surface PLUS
 * a real self-hosted Community-edition OneCLI `1.43.3` instance (same pinned image ONECLI-SPIKE.md
 * used), verified live 2026-08-05 — see plans/08-equipment-and-broker.md Evidence for exactly what
 * "verified" covers (a real, PVC-persistent, single-user deployment with the operator's real Claude
 * Max token linked; not yet a multi-user/HA production topology). Three points are genuine,
 * corrected-after-verification design decisions, each called out at its call site below:
 *
 * 1. `client.org.*` (createPolicyRule/publishPolicy/reorderPolicyRules/getPolicyLastPublish) is an
 *    Enterprise/Cloud-only surface — verified live: every `/v1/org/...` call 404s on a Community
 *    self-hosted instance with `{"error":"Organization-level resources require OneCLI Cloud or a
 *    self-hosted Enterprise instance"}`. The SDK does not expose the Community equivalent at all;
 *    it was found by reading the self-hosted dashboard's own compiled server bundle and confirmed
 *    live: a PROJECT-scoped REST surface (`/v1/policy/rules`, `/v1/policy/publish`,
 *    `/v1/policy/last-publish` — undocumented in the public API reference, which only documents the
 *    org-scoped variant, but functionally proven: an explicit allow + terminal block published this
 *    way was verified to let `api.anthropic.com` through while returning HTTP 403 for unlisted
 *    hosts). This adapter uses that surface directly via `fetch`, never `client.org`.
 * 2. The project-scoped rule schema's `identities` array DOES accept `{type: 'agent', id}` (unlike
 *    `OrgPolicyRuleIdentityInput`, which excludes it) — genuine per-Agent route scoping is possible
 *    here and was not previously known to be available. NOT adopted in this pass: `route-policy.ts`
 *    still compiles and publishes the project-wide union documented since P08 (a real, tested,
 *    correct behavior, just not the most precise one now available) — adopting per-Agent scoping is
 *    future work, not a correctness fix this pass makes.
 * 3. The SDK's `ensureAgent`/`EnsureAgentResponse` returns no internal `id`, but the REST endpoints
 *    for `rotate`/`delete` require that internal `id`, NOT the caller-supplied `identifier` string
 *    (verified live: calling either endpoint with `identifier` 404s "Agent not found"; the same call
 *    with the `id` from `GET /v1/agents` succeeds). `OneCliControlAdapter`'s own public contract
 *    intentionally still takes `identifier` (matching what `grant-service.ts` already stores/passes
 *    everywhere) — this adapter resolves `identifier -> id` via `listAgents()` internally rather
 *    than changing that wider contract.
 */
export interface OnecliSdkAdapterOptions {
  readonly apiKey: string
  readonly url?: string
  readonly gatewayUrl?: string
  readonly projectId?: string
  readonly timeout?: number
}

const AGORA_RULE_NAME_PREFIX = 'agora-route-'

interface PolicyRuleRow {
  readonly id: string
  readonly name: string
}

interface PublishResult {
  readonly generation: number
}

export function createOnecliSdkAdapter(options: OnecliSdkAdapterOptions): OneCliControlAdapter {
  const client = new OneCLI(options)
  const baseUrl = (options.url ?? 'https://api.onecli.sh').replace(/\/$/, '')

  async function restJson<T>(path: string, method: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) {
      throw new OneCliUnavailableError(`onecli ${method} ${path} failed: HTTP ${response.status}`)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** See class doc point 3: the REST rotate/delete endpoints need the internal `id`, not `identifier`. */
  async function resolveInternalAgentId(identifier: string): Promise<string> {
    const agents = await client.listAgents()
    const match = agents.find((agent) => agent.identifier === identifier)
    if (!match) throw new OneCliUnavailableError(`no onecli agent found for identifier ${identifier}`)
    return match.id
  }

  return {
    async ensureSelectiveAgent(identifier, name): Promise<OneCliAgentHandle> {
      try {
        const result = await client.ensureAgent({ name, identifier })
        return { identifier: result.identifier }
      } catch (error) {
        throw new OneCliUnavailableError(`ensureSelectiveAgent(${identifier}) failed: ${String(error)}`)
      }
    },

    // See class doc point 1: project-scoped REST (`/v1/policy/rules` + `/v1/policy/publish`), never
    // `client.org.*` — that surface 404s on Community self-hosted OneCLI.
    async publishRoutePolicy(routes: readonly PublishedRoute[]): Promise<RoutePolicyPublishResult> {
      const last = routes[routes.length - 1]
      if (!last || last.host !== '*' || last.action !== 'block') {
        throw new Error('route policy must end with an explicit terminal block *')
      }
      try {
        const existing = await restJson<PolicyRuleRow[]>('/v1/policy/rules', 'GET')
        for (const rule of existing) {
          if (rule.name.startsWith(AGORA_RULE_NAME_PREFIX)) {
            await restJson(`/v1/policy/rules/${encodeURIComponent(rule.id)}`, 'DELETE')
          }
        }
        // Priority is assigned by creation order (verified live) — recreating the complete set in
        // the caller's exact order reproduces first-match semantics without a separate reorder call.
        for (const [index, route] of routes.entries()) {
          await restJson('/v1/policy/rules', 'POST', {
            name: `${AGORA_RULE_NAME_PREFIX}${String(index).padStart(4, '0')}-${route.action}-${route.host}`,
            action: route.action,
            enabled: true,
            targets: [{ kind: 'network', hostPattern: route.host }],
          })
        }
        const published = await restJson<PublishResult>('/v1/policy/publish', 'POST')
        return { generation: published.generation }
      } catch (error) {
        if (error instanceof OneCliUnavailableError) throw error
        throw new OneCliUnavailableError(`publishRoutePolicy failed: ${String(error)}`)
      }
    },

    async getPublishedGeneration(): Promise<number | undefined> {
      try {
        const last = await restJson<PublishResult | null>('/v1/policy/last-publish', 'GET')
        return last?.generation
      } catch (error) {
        throw new OneCliUnavailableError(`getPublishedGeneration failed: ${String(error)}`)
      }
    },

    async getContainerConfig(identifier: string): Promise<OneCliContainerConfig> {
      try {
        const config = await client.getContainerConfig({ agent: identifier })
        const proxyUrl = config.env['HTTPS_PROXY'] ?? config.env['https_proxy']
        if (!proxyUrl) {
          throw new Error('container config carried no HTTPS_PROXY entry to extract the upstream bearer from')
        }
        const parsed = new URL(proxyUrl)
        // Found live, P11: the real credential is the PASSWORD half. OneCLI hands out
        // `http://x:aoc_…@gateway` — username is a fixed dummy (`x`), and this code used to take
        // ONLY that username as "the bearer", so the relay authenticated with the literal string
        // "x". The gateway then silently fell back to unauthenticated passthrough (no TLS
        // interception, no credential injection) and every real prompt died on a bare 401 from the
        // provider. Both halves are kept here, as the userinfo pair the gateway's HTTP Basic auth
        // actually expects — see `OneCliContainerConfig.upstreamProxyCredential`'s own doc.
        if (!parsed.password) {
          throw new Error('HTTPS_PROXY carried no embedded proxy password (expected user:token userinfo, per ONECLI-SPIKE.md)')
        }
        return {
          env: config.env,
          caCertificate: config.caCertificate,
          caCertificateContainerPath: config.caCertificateContainerPath,
          credentialStubs: config.credentialStubs ?? [],
          upstreamProxyCredential: `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
          gatewayUrl: `${parsed.protocol}//${parsed.host}`,
        }
      } catch (error) {
        throw new OneCliUnavailableError(`getContainerConfig(${identifier}) failed: ${String(error)}`)
      }
    },

    // See class doc point 3: verified live at `POST /v1/agents/{internal id}/regenerate-token`.
    async rotateAgentAuthority(identifier: string): Promise<void> {
      const id = await resolveInternalAgentId(identifier)
      await restJson(`/v1/agents/${encodeURIComponent(id)}/regenerate-token`, 'POST')
    },

    // See class doc point 3: verified live at `DELETE /v1/agents/{internal id}`.
    async deleteAgent(identifier: string): Promise<void> {
      const agents = await client.listAgents()
      const match = agents.find((agent) => agent.identifier === identifier)
      if (!match) return // already gone — deleteAgent is documented idempotent by its own interface
      await restJson(`/v1/agents/${encodeURIComponent(match.id)}`, 'DELETE')
    },
  }
}

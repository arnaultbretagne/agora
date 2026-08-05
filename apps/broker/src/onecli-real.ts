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
 * Best-effort SDK-backed implementation, wired against `@onecli-sh/sdk@3.0.0`'s actually-exposed
 * surface (see ONECLI-SPIKE.md and the pinned SDK's own `.d.ts`). NOT exercised against a live
 * OneCLI instance by this plan's test suite — every automated test in this plan uses
 * `FakeOneCliControlAdapter` instead (see plans/08-equipment-and-broker.md Evidence for the exact
 * scope of what "real" means here). Two design points are genuine, documented interpretations
 * rather than verified facts, each called out at its call site below:
 *
 * 1. The SDK exposes no `deleteAgent` or explicit `rotateAgentAuthority` method. Both are
 *    implemented here as direct REST calls inferred from the SDK's own request shape
 *    (`Authorization: Bearer <apiKey>`, JSON body) against a guessed path
 *    (`DELETE /v1/agents/{identifier}`, `POST /v1/agents/{identifier}/rotate`). This is NOT
 *    verified against the real OneCLI API and must be confirmed (or replaced) before this
 *    adapter is trusted with real credentials.
 * 2. `CreateOrgPolicyRuleInput.identities` explicitly excludes `type: 'agent'`
 *    (`OrgPolicyRuleIdentityInput = Exclude<PolicyRuleIdentity['type'], 'agent'>`) — this SDK
 *    version's org policy rules cannot target one specific Agent by identity. Per-Session
 *    differentiation therefore cannot come from per-Agent network rules; it comes from which
 *    Agent has which selective credential (`ensureSelectiveAgent` + OneCLI's own credential
 *    scoping, proven in ONECLI-SPIKE.md's "Per-Agent credential selection: PASS"). Route/network
 *    policy published here is PROJECT-WIDE: the caller must pass the UNION of routes needed by
 *    every currently-active grant, not just the one grant being issued.
 */
export interface OnecliSdkAdapterOptions {
  readonly apiKey: string
  readonly url?: string
  readonly gatewayUrl?: string
  readonly projectId?: string
  readonly timeout?: number
}

const AGORA_RULE_NAME_PREFIX = 'agora-route-'

export function createOnecliSdkAdapter(options: OnecliSdkAdapterOptions): OneCliControlAdapter {
  const client = new OneCLI(options)
  const baseUrl = (options.url ?? 'https://api.onecli.sh').replace(/\/$/, '')

  async function restCall(path: string, method: string): Promise<void> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
    })
    if (!response.ok) {
      throw new OneCliUnavailableError(`onecli ${method} ${path} failed: HTTP ${response.status}`)
    }
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

    async publishRoutePolicy(routes: readonly PublishedRoute[]): Promise<RoutePolicyPublishResult> {
      const last = routes[routes.length - 1]
      if (!last || last.host !== '*' || last.action !== 'block') {
        throw new Error('route policy must end with an explicit terminal block *')
      }
      try {
        const existing = await client.org.listPolicyRules('draft')
        for (const rule of existing) {
          if (rule.name.startsWith(AGORA_RULE_NAME_PREFIX)) {
            await client.org.deletePolicyRule(rule.id, { skipPublish: true })
          }
        }
        const createdIds: string[] = []
        for (const [index, route] of routes.entries()) {
          const created = await client.org.createPolicyRule(
            {
              name: `${AGORA_RULE_NAME_PREFIX}${String(index).padStart(4, '0')}-${route.action}-${route.host}`,
              action: route.action,
              targets: [{ kind: 'network', hostPattern: route.host }],
            },
            { skipPublish: true },
          )
          createdIds.push(created.result.id)
        }
        await client.org.reorderPolicyRules(createdIds, { skipPublish: true })
        const published = await client.org.publishPolicy()
        return { generation: published.generation }
      } catch (error) {
        throw new OneCliUnavailableError(`publishRoutePolicy failed: ${String(error)}`)
      }
    },

    async getPublishedGeneration(): Promise<number | undefined> {
      try {
        const last = await client.org.getPolicyLastPublish()
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
        if (!parsed.username) {
          throw new Error('HTTPS_PROXY carried no embedded bearer (expected userinfo, per ONECLI-SPIKE.md)')
        }
        return {
          env: config.env,
          caCertificate: config.caCertificate,
          caCertificateContainerPath: config.caCertificateContainerPath,
          credentialStubs: config.credentialStubs ?? [],
          upstreamBearer: decodeURIComponent(parsed.username),
          gatewayUrl: `${parsed.protocol}//${parsed.host}`,
        }
      } catch (error) {
        throw new OneCliUnavailableError(`getContainerConfig(${identifier}) failed: ${String(error)}`)
      }
    },

    // No SDK method exists for this (see class doc, point 1) — inferred REST call, unverified.
    async rotateAgentAuthority(identifier: string): Promise<void> {
      await restCall(`/v1/agents/${encodeURIComponent(identifier)}/rotate`, 'POST')
    },

    // No SDK method exists for this (see class doc, point 1) — inferred REST call, unverified.
    async deleteAgent(identifier: string): Promise<void> {
      await restCall(`/v1/agents/${encodeURIComponent(identifier)}`, 'DELETE')
    },
  }
}

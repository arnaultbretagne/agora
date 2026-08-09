import { OneCLI } from '@onecli-sh/sdk'
import type { DesiredCredentialGrants } from './credential-policy.js'
import type {
  AttachedCredentials,
  EffectiveCredentialSet,
  OneCliAgentHandle,
  OneCliAgentSummary,
  OneCliContainerConfig,
  OneCliControlAdapter,
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
 * 1. **The project-policy surface this adapter used until P13 is gone upstream.** `client.org.*`
 *    (createPolicyRule/publishPolicy/…) is Enterprise/Cloud-only — verified live, every
 *    `/v1/org/...` call 404s on Community self-hosted — and the project-scoped REST twin this
 *    adapter used instead (`/v1/policy/rules`, `/v1/policy/publish`, `/v1/policy/last-publish`)
 *    was retired in OneCLI 1.44.0. Measured on a staging 1.45.0 instance, 2026-08-09: all of them,
 *    plus `/v1/rules`, answer `410 Gone` with "project rules are compiled from agent credential
 *    grants, not authored directly". Per ADR 0015 this adapter no longer authors project policy at
 *    all: credential selection moved to per-Agent grants (below), and network egress moved to
 *    Agora's own relay (`route-policy.ts` + `relay.ts`).
 * 2. **Grants are the credential surface** (`PUT|DELETE /v1/agents/{id}/grants/{secrets|
 *    connections}/{id}`), reached by raw `restJson` because `@onecli-sh/sdk@3.0.0` (a 1.43.x-era
 *    build) exposes no grant-attach method — re-check that surface if the SDK is ever bumped. They
 *    take effect immediately: there is no publish step and no generation to read back, so the old
 *    publish-then-verify is replaced by reading OneCLI's own `effective-credentials` oracle.
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

interface SecretRow {
  readonly id: string
  readonly name: string
  readonly type: string
}

interface ConnectionRow {
  readonly id: string
  readonly provider: string
}

/** `GET /v1/agents/{id}/grants` — what the Agent currently holds. */
interface AgentGrantsRow {
  readonly secrets?: readonly { readonly secretId: string }[]
  readonly connections?: readonly { readonly connectionId: string }[]
}

interface EffectiveCredentialsRow {
  readonly mode: string
  readonly secrets?: readonly { readonly id: string; readonly status: string }[]
  readonly connections?: readonly { readonly id: string; readonly status: string }[]
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

    /**
     * See class doc points 1 and 2. Converges the Agent onto exactly `desired`:
     *
     * - resolves each wanted secret `type` and connection `provider` to OneCLI's per-instance id
     *   (`GET /v1/secrets` / `GET /v1/connections`) — nothing is hardcoded, so re-creating a secret
     *   in the OneCLI dashboard cannot silently un-grant a Session;
     * - attaches what is missing and DETACHES everything else the Agent currently holds, so a
     *   re-issue can never leave a credential from a previous equipment set behind;
     * - refuses to guess: a type/provider the operator has not configured is a hard failure, never
     *   a silently smaller grant set.
     *
     * Secret grants are assign-only (no body, all-or-nothing). Connection grants carry
     * `{"access":"custom","allow":[…],"ask":[]}` — `ask` is deliberately always empty, see
     * `credential-policy.ts` for why a headless Session must never be given an approval-gated tool.
     */
    async syncCredentialGrants(identifier: string, desired: DesiredCredentialGrants): Promise<AttachedCredentials> {
      const agentId = await resolveInternalAgentId(identifier)
      const [secrets, connections] = await Promise.all([
        restJson<SecretRow[]>('/v1/secrets', 'GET'),
        restJson<ConnectionRow[]>('/v1/connections', 'GET'),
      ])

      const wantedSecretIds: string[] = []
      for (const type of desired.secretTypes) {
        const match = secrets.find((secret) => secret.type === type)
        if (!match) {
          throw new OneCliUnavailableError(`onecli holds no secret of type '${type}', required by Agent ${identifier} — refusing to issue a grant that cannot inject its provider credential`)
        }
        wantedSecretIds.push(match.id)
      }

      const wantedConnections = desired.connections.map((wanted) => {
        const match = connections.find((connection) => connection.provider === wanted.provider)
        if (!match) {
          throw new OneCliUnavailableError(`onecli holds no connection for provider '${wanted.provider}', required by Agent ${identifier} — refusing to issue a grant that cannot reach its equipment`)
        }
        return { id: match.id, allowedToolIds: wanted.allowedToolIds }
      })

      const held = await restJson<AgentGrantsRow>(`/v1/agents/${encodeURIComponent(agentId)}/grants`, 'GET')
      const heldSecretIds = (held.secrets ?? []).map((entry) => entry.secretId)
      const heldConnectionIds = (held.connections ?? []).map((entry) => entry.connectionId)

      for (const secretId of heldSecretIds) {
        if (!wantedSecretIds.includes(secretId)) {
          await restJson(`/v1/agents/${encodeURIComponent(agentId)}/grants/secrets/${encodeURIComponent(secretId)}`, 'DELETE')
        }
      }
      for (const connectionId of heldConnectionIds) {
        if (!wantedConnections.some((wanted) => wanted.id === connectionId)) {
          await restJson(`/v1/agents/${encodeURIComponent(agentId)}/grants/connections/${encodeURIComponent(connectionId)}`, 'DELETE')
        }
      }

      // Attach unconditionally rather than only when missing: `PUT` is idempotent (OneCLI reports
      // `changed:false` for a no-op) and re-asserting the tool list is what makes an equipment
      // re-resolution actually take effect on an Agent that already holds the connection.
      for (const secretId of wantedSecretIds) {
        await restJson(`/v1/agents/${encodeURIComponent(agentId)}/grants/secrets/${encodeURIComponent(secretId)}`, 'PUT')
      }
      for (const connection of wantedConnections) {
        await restJson(`/v1/agents/${encodeURIComponent(agentId)}/grants/connections/${encodeURIComponent(connection.id)}`, 'PUT', {
          access: 'custom',
          allow: connection.allowedToolIds,
          ask: [],
        })
      }

      return { secretIds: wantedSecretIds, connectionIds: wantedConnections.map((connection) => connection.id) }
    },

    async getEffectiveCredentials(identifier: string): Promise<EffectiveCredentialSet> {
      const agentId = await resolveInternalAgentId(identifier)
      const effective = await restJson<EffectiveCredentialsRow>(`/v1/agents/${encodeURIComponent(agentId)}/effective-credentials`, 'GET')
      return {
        mode: effective.mode,
        secrets: (effective.secrets ?? []).map((entry) => ({ id: entry.id, status: entry.status })),
        connections: (effective.connections ?? []).map((entry) => ({ id: entry.id, status: entry.status })),
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

    /** Identifier + creation time only. `GET /v1/agents` rows carry each Agent's `accessToken` in
     * cleartext; this adapter never returns, logs or stores that field. */
    async listAgents(): Promise<readonly OneCliAgentSummary[]> {
      try {
        const agents = await client.listAgents()
        return agents.map((agent) => ({ identifier: agent.identifier, createdAt: new Date(agent.createdAt) }))
      } catch (error) {
        throw new OneCliUnavailableError(`listAgents failed: ${String(error)}`)
      }
    },
  }
}

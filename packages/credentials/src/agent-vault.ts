// Agent Vault 0.39.3 seen from Agora (docs/credentials.md). Agora holds an agent token with the
// `member` role on one vault: the least that may mint sessions, which also lets it read and change
// the vault's credentials — so it stays in Agora and never reaches a sandbox. For an execution it
// mints a session with the `proxy` role only (POST /v1/sessions), whose token opens the MITM proxy
// and nothing else, and hands it to the execution's bridge.
import { readFile } from 'node:fs/promises'
import type { Credentials } from '@agora/harness-bridge/outbound'

/** Agent Vault's own bounds on a session's lifetime (scopedSessionMinTTL / MaxTTL). */
export const SESSION_TTL_BOUNDS = [300, 7 * 24 * 3600] as const

export interface AgentVaultOptions {
  /** The management API, e.g. http://agent-vault-api.agent-vault.svc.cluster.local:14321. */
  readonly api: string
  /** The MITM proxy as the bridge reaches it, `host:port`. */
  readonly proxy: string
  readonly vault: string
  /** Read at each mint, so that a rotated Secret is picked up without a restart. */
  readonly agentTokenFile: string
  readonly fetch?: typeof fetch
}

export class AgentVaultRefused extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class AgentVault {
  private readonly options: AgentVaultOptions

  constructor(options: AgentVaultOptions) {
    this.options = options
  }

  describe(): { vault: string; proxy: string } {
    return { vault: this.options.vault, proxy: this.options.proxy }
  }

  async mint(input: { label: string; ttlSeconds: number }): Promise<Credentials> {
    const [min, max] = SESSION_TTL_BOUNDS
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < min || input.ttlSeconds > max) {
      throw new AgentVaultRefused(400, `durée hors bornes : ${String(min)} à ${String(max)} s`)
    }
    const agentToken = (await readFile(this.options.agentTokenFile, 'utf8')).trim()
    if (agentToken === '') throw new AgentVaultRefused(503, "jeton d'agent Agent Vault vide")
    const response = await (this.options.fetch ?? fetch)(`${this.options.api.replace(/\/$/, '')}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ vault: this.options.vault, vault_role: 'proxy', ttl_seconds: input.ttlSeconds, label: input.label.slice(0, 100) }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await response.json().catch(() => ({}))) as { token?: unknown; expires_at?: unknown; error?: unknown }
    if (!response.ok) throw new AgentVaultRefused(response.status, `Agent Vault a refusé (${String(response.status)}) : ${String(body.error ?? response.statusText)}`)
    if (typeof body.token !== 'string' || body.token === '') throw new AgentVaultRefused(502, 'Agent Vault n’a pas rendu de jeton')
    return { proxy: this.options.proxy, token: body.token, expiresAt: typeof body.expires_at === 'string' && body.expires_at !== '' ? body.expires_at : null }
  }
}

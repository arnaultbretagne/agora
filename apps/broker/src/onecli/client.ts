// Raw REST client against the pinned OneCLI (ADR 0009; S7 Step 2). Verified live, 2026-09-06
// (apps/broker/README.md), against the authoritative reference at https://onecli.sh/docs/openapi.yaml.
// Every method here is exactly one documented endpoint — no inferred behavior, no retry policy (the
// owner-request gate above this client owns retries and idempotency).
import { request as httpRequest } from 'node:http'

export interface HttpError extends Error {
  status: number
  body?: unknown
}

export function describeOneCliError(method: string, path: string, status: number, body: unknown): string {
  const message =
    typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'object'
      ? ((body as { error: { message?: unknown } }).error.message as string | undefined)
      : typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : undefined
  return `OneCLI API ${method} ${path} -> ${status}${message ? `: ${message}` : ''}`
}

export interface OneCliAgent {
  readonly id: string
  readonly name: string
  readonly identifier: string
  readonly accessToken?: string
  readonly isDefault: boolean
  readonly createdAt: string
}

export interface OneCliSecret {
  readonly id: string
  readonly name: string
  readonly type: 'anthropic' | 'openai' | 'generic'
  readonly scope: 'project' | 'organization'
}

export interface OneCliConnection {
  readonly id: string
  readonly provider: string
  readonly label: string | null
  readonly scope: 'project' | 'organization'
}

export interface AgentGrantConnection {
  readonly connectionId: string
  readonly provider: string
  readonly access: 'full' | 'custom'
  readonly allow: readonly string[]
  readonly ask: readonly string[]
}

export interface AgentGrantSecret {
  readonly secretId: string
  readonly name: string
  readonly type: string
}

export interface AgentGrants {
  readonly agentId: string
  readonly connections: readonly AgentGrantConnection[]
  readonly secrets: readonly AgentGrantSecret[]
}

export interface EffectiveCredential {
  readonly kind: 'secret' | 'connection'
  readonly id: string
  readonly name?: string
  readonly label?: string | null
  readonly status: string
  readonly host?: string
  readonly orgBlocked?: boolean
}

export interface EffectiveCredentials {
  readonly agentId: string
  readonly mode: 'selective' | 'all'
  readonly secrets: readonly EffectiveCredential[]
  readonly connections: readonly EffectiveCredential[]
}

export type ConnectionGrantInput = { readonly access: 'full' } | { readonly access: 'custom'; readonly allow: readonly string[]; readonly ask: readonly string[] }

export interface ContainerConfig {
  readonly env: Record<string, string>
  readonly caCertificate: string
  readonly caCertificateContainerPath: string
  readonly credentialStubs: readonly { readonly containerPath: string; readonly content: string }[]
  readonly warnings: readonly string[]
}

export interface OneCliClient {
  listAgents(): Promise<readonly OneCliAgent[]>
  createAgent(name: string, identifier: string): Promise<{ id: string; name: string; identifier: string; createdAt: string }>
  deleteAgent(agentId: string): Promise<void>
  getAgentGrants(agentId: string): Promise<AgentGrants>
  getEffectiveCredentials(agentId: string): Promise<EffectiveCredentials>
  setAgentSecretGrant(agentId: string, secretId: string): Promise<AgentGrants>
  removeAgentSecretGrant(agentId: string, secretId: string): Promise<void>
  setAgentConnectionGrant(agentId: string, connectionId: string, grant: ConnectionGrantInput): Promise<AgentGrants>
  removeAgentConnectionGrant(agentId: string, connectionId: string): Promise<void>
  listSecrets(): Promise<readonly OneCliSecret[]>
  listConnections(provider?: string): Promise<readonly OneCliConnection[]>
  getContainerConfig(agentIdentifier: string): Promise<ContainerConfig>
}

export interface HttpOneCliClientOptions {
  readonly baseUrl: string
  readonly apiKey: string
}

export class HttpOneCliClient implements OneCliClient {
  readonly #baseUrl: URL
  readonly #apiKey: string

  constructor(options: HttpOneCliClientOptions) {
    this.#baseUrl = new URL(options.baseUrl)
    this.#apiKey = options.apiKey
  }

  async listAgents(): Promise<readonly OneCliAgent[]> {
    return this.call('GET', '/v1/agents') as Promise<readonly OneCliAgent[]>
  }

  async createAgent(name: string, identifier: string): Promise<{ id: string; name: string; identifier: string; createdAt: string }> {
    return this.call('POST', '/v1/agents', { name, identifier }) as Promise<{ id: string; name: string; identifier: string; createdAt: string }>
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.call('DELETE', `/v1/agents/${agentId}`)
    } catch (error) {
      if ((error as HttpError).status === 404) return // already gone — naturally idempotent (apps/broker/README.md)
      throw error
    }
  }

  async getAgentGrants(agentId: string): Promise<AgentGrants> {
    return this.call('GET', `/v1/agents/${agentId}/grants`) as Promise<AgentGrants>
  }

  async getEffectiveCredentials(agentId: string): Promise<EffectiveCredentials> {
    return this.call('GET', `/v1/agents/${agentId}/effective-credentials`) as Promise<EffectiveCredentials>
  }

  async setAgentSecretGrant(agentId: string, secretId: string): Promise<AgentGrants> {
    return this.call('PUT', `/v1/agents/${agentId}/grants/secrets/${secretId}`) as Promise<AgentGrants>
  }

  async removeAgentSecretGrant(agentId: string, secretId: string): Promise<void> {
    try {
      await this.call('DELETE', `/v1/agents/${agentId}/grants/secrets/${secretId}`)
    } catch (error) {
      if ((error as HttpError).status === 404) return
      throw error
    }
  }

  async setAgentConnectionGrant(agentId: string, connectionId: string, grant: ConnectionGrantInput): Promise<AgentGrants> {
    return this.call('PUT', `/v1/agents/${agentId}/grants/connections/${connectionId}`, grant) as Promise<AgentGrants>
  }

  async removeAgentConnectionGrant(agentId: string, connectionId: string): Promise<void> {
    try {
      await this.call('DELETE', `/v1/agents/${agentId}/grants/connections/${connectionId}`)
    } catch (error) {
      if ((error as HttpError).status === 404) return
      throw error
    }
  }

  async listSecrets(): Promise<readonly OneCliSecret[]> {
    return this.call('GET', '/v1/secrets') as Promise<readonly OneCliSecret[]>
  }

  async listConnections(provider?: string): Promise<readonly OneCliConnection[]> {
    const query = provider !== undefined ? `?provider=${encodeURIComponent(provider)}` : ''
    return this.call('GET', `/v1/connections${query}`) as Promise<readonly OneCliConnection[]>
  }

  async getContainerConfig(agentIdentifier: string): Promise<ContainerConfig> {
    return this.call('GET', `/v1/container-config?agent=${encodeURIComponent(agentIdentifier)}`) as Promise<ContainerConfig>
  }

  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined
      const req = httpRequest(
        {
          method,
          hostname: this.#baseUrl.hostname,
          port: this.#baseUrl.port,
          protocol: this.#baseUrl.protocol,
          path,
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            ...(data ? { 'content-length': String(data.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode ?? 0
            let json: unknown
            try {
              json = text ? JSON.parse(text) : undefined
            } catch {
              json = text
            }
            if (status >= 200 && status < 300) return resolve(json)
            reject(Object.assign(new Error(describeOneCliError(method, path, status, json)), { status, body: json }))
          })
        },
      )
      req.on('error', reject)
      if (data !== undefined) req.write(data)
      req.end()
    })
  }
}

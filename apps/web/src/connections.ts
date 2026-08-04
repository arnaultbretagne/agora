import type * as acp from '@agentclientprotocol/sdk'
import type { StorePersist } from '@agora/acp'

export interface LiveAcpConnection {
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
  readonly storePersist: StorePersist
}

/**
 * Live ACP connections exist only for the lifetime of this process (ADR 0012 "Web state as a
 * composed read" — nothing here is durable truth; the durable Session phase in Postgres is). A
 * process restart loses connections the same way it loses any other in-memory runtime state; the
 * durable phase alone is what the product API/UI ever treat as authoritative.
 */
export class SessionConnectionRegistry {
  private readonly bySessionId = new Map<string, LiveAcpConnection>()

  set(sessionId: string, value: LiveAcpConnection): void {
    this.bySessionId.set(sessionId, value)
  }

  get(sessionId: string): LiveAcpConnection | undefined {
    return this.bySessionId.get(sessionId)
  }

  delete(sessionId: string): void {
    this.bySessionId.delete(sessionId)
  }
}

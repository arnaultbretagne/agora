// Live ACP channels for the control plane (S4): one channel per Workstream against the local
// development harness. The channel owns the capture seam's database client (product authority)
// and the projector client (projector authority), sends commands whose dispatch was already
// reserved, and records the honest delivery states — never inventing them.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import {
  buildClientConnection,
  createPersist,
  initializeParams,
  startFakeAgent,
  markDispatched,
  markResponded,
  markUnknown,
  type DevHarness,
} from '@agora/acp'
import { createAcpModelProjector, runIncremental } from '@agora/projections'

export interface ChannelManagerOptions {
  readonly pool: pg.Pool
  readonly nowSql?: string
  readonly logger?: (message: string) => void
  /** Test hook: delays the fake agent's reply so interleavings are observable. */
  readonly promptDelayMs?: number
}

interface PendingPermission {
  readonly id: string
  readonly resolve: (decision: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }) => void
}

interface InnerChannel {
  readonly workstreamId: string
  readonly sessionId: string
  readonly connectionId: string
  connection: acp.ClientConnection
  readonly harness: DevHarness
  acpSessionId: string
  readonly productClient: pg.PoolClient
  projectorClient: pg.PoolClient
  currentCommandId: string | null
  readonly pendingPermissions: Map<string, PendingPermission>
}

export class AgentChannels {
  readonly #channels = new Map<string, InnerChannel>()
  readonly #pool: pg.Pool
  readonly #nowSql: string
  readonly #logger: (message: string) => void
  readonly #promptDelayMs: number | undefined

  constructor(options: ChannelManagerOptions) {
    this.#pool = options.pool
    this.#nowSql = options.nowSql ?? 'now()'
    this.#logger = options.logger ?? (() => {})
    this.#promptDelayMs = options.promptDelayMs
  }

  pendingPermissionIds(workstreamId: string): readonly string[] {
    return [...(this.#channels.get(workstreamId)?.pendingPermissions.keys() ?? [])]
  }

  /** Opens (or reuses) the channel for the Workstream's current Session. */
  async ensure(workstreamId: string, sessionId: string): Promise<InnerChannel> {
    const existing = this.#channels.get(workstreamId)
    if (existing && existing.sessionId === sessionId) return existing
    if (existing) await this.close(workstreamId)

    const connectionId = randomUUID()
    const productClient = await this.#pool.connect()
    await productClient.query('SET ROLE agora_product')
    const persist = createPersist(productClient, {
      workstreamId,
      sessionId,
      connectionId,
      nowSql: this.#nowSql,
      commandIdFor: (direction, method) =>
        direction === 'client_to_agent' && method === 'session/prompt' ? (this.#channels.get(workstreamId)?.currentCommandId ?? null) : null,
    })
    const harness = startFakeAgent({ promptDelayMs: this.#promptDelayMs })
    const pendingPermissions = new Map<string, PendingPermission>()
    const channel: InnerChannel = {
      workstreamId,
      sessionId,
      connectionId,
      harness,
      pendingPermissions,
      productClient,
      projectorClient: null as unknown as pg.PoolClient,
      connection: null as unknown as acp.ClientConnection,
      acpSessionId: '',
      currentCommandId: null,
    }
    this.#channels.set(workstreamId, channel)

    const connection = buildClientConnection(harness.clientStream, persist, {
      onPermissionRequest: async (params) => {
        const id = randomUUID()
        const decision = new Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }>((resolve) => {
          pendingPermissions.set(id, { id, resolve })
        })
        void decision.then(() => pendingPermissions.delete(id))
        return decision
      },
    })
    channel.connection = connection
    await connection.agent.request(acp.methods.agent.initialize, initializeParams('/workspace'))
    channel.acpSessionId = ((await connection.agent.request(acp.methods.agent.session.new, { cwd: '/workspace', mcpServers: [] })) as { sessionId: string }).sessionId

    const projectorClient = await this.#pool.connect()
    await projectorClient.query('SET ROLE agora_projector')
    channel.projectorClient = projectorClient
    return channel
  }

  /**
   * Sends the reserved prompt: dispatch mark, transport, response correlation. Any failure after
   * dispatch leaves `unknown` — never a fabricated outcome (CONT-005 shape).
   */
  async prompt(workstreamId: string, commandId: string, text: string): Promise<void> {
    const channel = this.#channels.get(workstreamId)
    if (channel === undefined) throw new Error('channel_not_open')
    channel.currentCommandId = commandId
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await markDispatched(client, commandId)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      throw error
    }
    client.release()

    try {
      await channel.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: channel.acpSessionId,
        prompt: [{ type: 'text', text }],
      })
      const settled = await this.#pool.connect()
      try {
        await settled.query('BEGIN')
        await markResponded(settled, commandId)
        await settled.query('COMMIT')
      } catch (error) {
        await settled.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        settled.release()
      }
    } catch (error) {
      this.#logger(`prompt ${commandId} ended unknown: ${error instanceof Error ? error.message : String(error)}`)
      const failing = await this.#pool.connect()
      try {
        await failing.query('BEGIN')
        await markUnknown(failing, commandId)
        await failing.query('COMMIT')
      } finally {
        failing.release()
      }
    } finally {
      channel.currentCommandId = null
      await this.runProjectors(workstreamId)
    }
  }

  async cancel(workstreamId: string, commandId?: string): Promise<void> {
    const channel = this.#channels.get(workstreamId)
    if (channel === undefined) throw new Error('channel_not_open')
    await channel.connection.agent.request(acp.methods.agent.session.cancel, { sessionId: channel.acpSessionId, reason: 'operator requested' }).catch(() => {})
    void commandId
  }

  decidePermission(workstreamId: string, permissionId: string, optionId: string): boolean {
    const pending = this.#channels.get(workstreamId)?.pendingPermissions.get(permissionId)
    if (pending === undefined) return false
    pending.resolve({ outcome: { outcome: 'selected', optionId } })
    return true
  }

  async runProjectors(workstreamId: string): Promise<void> {
    const channel = this.#channels.get(workstreamId)
    if (channel === undefined) return
    const projector = createAcpModelProjector({})
    await this.#pool.query('SELECT 1')
    const client = channel.projectorClient
    await client.query('BEGIN')
    try {
      await runIncremental(client, workstreamId, projector)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      this.#logger(`projector run failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async close(workstreamId: string): Promise<void> {
    const channel = this.#channels.get(workstreamId)
    if (channel === undefined) return
    this.#channels.delete(workstreamId)
    // Closing OUR client connection is what rejects the in-flight request (the SDK rejects this
    // connection's pending responses); closing only the harness would leave the turn hanging.
    channel.connection.close()
    channel.harness.close()
    // A client returned to the pool must not carry its SET ROLE: the next borrower would inherit
    // a restricted role silently (the exact failure class findings §5 warns about).
    await channel.productClient.query('RESET ROLE').catch(() => {})
    channel.productClient.release()
    await channel.projectorClient.query('RESET ROLE').catch(() => {})
    channel.projectorClient.release()
  }

  async closeAll(): Promise<void> {
    for (const workstreamId of [...this.#channels.keys()]) {
      await this.close(workstreamId)
    }
  }
}

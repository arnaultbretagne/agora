// Live ACP channels for the control plane (S4, real bridge wiring in S8): one channel per
// Workstream. The channel owns the capture seam's database client (product authority) and the
// projector client (projector authority), sends commands whose dispatch was already reserved, and
// records the honest delivery states — never inventing them. The transport itself is pluggable
// (ChannelConnector): a dev/test connector wires the in-process fake agent (S4, still the default —
// existing tests never pass one), a real connector (real-channel-connector.ts) resumes the
// Workstream's own ACP context over the harness Pod's real bridge. Either way, `ensure()` never
// calls session/new against an EXISTING context — only a connector reporting no `existingContextId`
// (the dev fake agent, which owns no prior binding) ever gets a fresh one; the real connector always
// resumes what START already bound (never a second, real session/new).
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
  type DuplexByteStream,
} from '@agora/acp'
import { createAcpModelProjector, runIncremental } from '@agora/projections'

/** The fixed workspace root every harness Session uses (S8 Step 2+ — verbs/start.ts and
 * session-probe.ts use the exact same literal; kept independently here since agent-channel.ts
 * predates workspace-root.ts and a shared import would be the only reason to touch this otherwise
 * stable S4 constant). */
const WORKSPACE_ROOT = '/workspace'

export interface ChannelConnection {
  readonly stream: DuplexByteStream
  readonly close: () => void | Promise<void>
  /** The ACP context to `session/resume`, already bound elsewhere (S8 START) — undefined only for
   * a connector with no prior binding of its own (the dev fake agent), which then gets a fresh
   * `session/new` instead. Never resolved by guessing; a real connector throws rather than omit it. */
  readonly existingContextId?: string
}

export interface ChannelConnector {
  connect(workstreamId: string): Promise<ChannelConnection>
}

/** S4's own default: an in-process fake ACP Agent, a fresh `session/new` every time (findings §7 —
 * `startFakeAgent` behavior is otherwise unchanged, still the implicit default for every existing
 * caller that never passes its own `connector`). */
export class DevChannelConnector implements ChannelConnector {
  constructor(private readonly promptDelayMs?: number) {}

  async connect(): Promise<ChannelConnection> {
    const harness = startFakeAgent({ promptDelayMs: this.promptDelayMs })
    return { stream: harness.clientStream, close: () => harness.close() }
  }
}

export interface ChannelManagerOptions {
  readonly pool: pg.Pool
  readonly nowSql?: string
  readonly logger?: (message: string) => void
  /** Test hook: delays the fake agent's reply so interleavings are observable. Ignored by a real connector. */
  readonly promptDelayMs?: number
  /** Defaults to DevChannelConnector (S4 behavior, unchanged) — apps/control-plane/src/main.ts wires
   * the real one (real-channel-connector.ts) once the owners are configured. */
  readonly connector?: ChannelConnector
}

export type CancelOutcome = 'cancel_sent' | 'not_active'

interface PendingPermission {
  readonly id: string
  readonly resolve: (decision: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }) => void
}

interface InnerChannel {
  readonly workstreamId: string
  readonly sessionId: string
  readonly connectionId: string
  connection: acp.ClientConnection
  close: () => void | Promise<void>
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
  readonly #connector: ChannelConnector

  constructor(options: ChannelManagerOptions) {
    this.#pool = options.pool
    this.#nowSql = options.nowSql ?? 'now()'
    this.#logger = options.logger ?? (() => {})
    this.#connector = options.connector ?? new DevChannelConnector(options.promptDelayMs)
  }

  pendingPermissionIds(workstreamId: string): readonly string[] {
    return [...(this.#channels.get(workstreamId)?.pendingPermissions.keys() ?? [])]
  }

  /** Opens (or reuses) the channel for the Workstream's current Session. */
  async ensure(workstreamId: string, sessionId: string): Promise<InnerChannel> {
    const existing = this.#channels.get(workstreamId)
    if (existing && existing.sessionId === sessionId) return existing
    if (existing) await this.close(workstreamId)

    const connected = await this.#connector.connect(workstreamId)
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
    const pendingPermissions = new Map<string, PendingPermission>()
    const channel: InnerChannel = {
      workstreamId,
      sessionId,
      connectionId,
      close: connected.close,
      pendingPermissions,
      productClient,
      projectorClient: null as unknown as pg.PoolClient,
      connection: null as unknown as acp.ClientConnection,
      acpSessionId: '',
      currentCommandId: null,
    }
    this.#channels.set(workstreamId, channel)

    const connection = buildClientConnection(connected.stream, persist, {
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
    await connection.agent.request(acp.methods.agent.initialize, initializeParams(WORKSPACE_ROOT))
    channel.acpSessionId =
      connected.existingContextId !== undefined
        ? await resumeExistingContext(connection, connected.existingContextId)
        : ((await connection.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })) as { sessionId: string }).sessionId

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

  /**
   * A delayed cancel verifies the intended context and active turn (execution.md — prompt
   * recovery) before sending anything: by the time an operator's cancel arrives, the turn it meant
   * may already have finished (or a later one may already be in flight) — `commandId` names exactly
   * which turn the caller intends to stop, and a cancel that no longer matches the channel's own
   * current one is a safe no-op, never a blind "cancel whatever's active right now".
   */
  async cancel(workstreamId: string, commandId: string): Promise<CancelOutcome> {
    const channel = this.#channels.get(workstreamId)
    if (channel === undefined) throw new Error('channel_not_open')
    if (channel.currentCommandId !== commandId) return 'not_active'
    // `session/cancel` is a NOTIFICATION (schema.CancelNotification, AgentNotificationMethod), not
    // a request — the S4-era code that called `.request(...)` here compiled (the SDK's generic
    // string-method overload accepts it) but semantically asked the agent for a JSON-RPC response
    // to a method it never answers, awaiting a reply that never comes. `.notify()` never inherited
    // that: fire-and-forget, exactly what ACP itself specifies for this method.
    // schema.CancelNotification carries only sessionId (+ _meta) — no `reason` field exists on the
    // real protocol; the S4-era code invented one that every peer would have silently dropped.
    await channel.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: channel.acpSessionId }).catch(() => {})
    return 'cancel_sent'
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
    // connection's pending responses); closing only the transport would leave the turn hanging.
    channel.connection.close()
    await channel.close()
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

/** `session/resume` never echoes a sessionId back (ResumeSessionResponse carries only modes/
 * configOptions) — the id to use afterward is the one we asked to resume, confirmed live. */
async function resumeExistingContext(connection: acp.ClientConnection, contextId: string): Promise<string> {
  await connection.agent.request(acp.methods.agent.session.resume, { sessionId: contextId, cwd: WORKSPACE_ROOT, mcpServers: [] })
  return contextId
}

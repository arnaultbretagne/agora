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
import { loadLatestIntentEvent } from '@agora/engine'
import { workspaceRoot } from './workspace-root.js'

/** The fixed workspace root every harness Session uses (S8 Step 2+ — verbs/start.ts and
 * session-probe.ts use the exact same literal; kept independently here since agent-channel.ts
 * predates workspace-root.ts and a shared import would be the only reason to touch this otherwise
 * stable S4 constant). */


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
  /**
   * How each harness's contexts behave on attach, by harness id — the same reviewed fact the
   * catalogue already states as `configReadback`.
   *
   * `resume` re-attaches with `session/resume`. `set-config-noop` means this adapter does not
   * persist a context until it has content, so resuming one that has never been prompted fails
   * outright — codex answers `Internal error: no rollout found for thread id`, which is precisely
   * what stopped every first prompt to a codex Workstream on the live cluster. For those, the bound
   * context is used as it is: the connector has already verified the binding belongs to the CURRENT
   * process generation, and that is exactly the condition under which the adapter still holds it in
   * memory. A generation change is refused earlier, and START rebinds.
   */
  readonly configReadback?: ReadonlyMap<string, 'resume' | 'set-config-noop'>
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
  readonly view: PendingPermissionView
  readonly resolve: (decision: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }) => void
}

/**
 * A permission request the agent is BLOCKED on, in the shape an operator has to answer it: the
 * options the agent itself offered, by their own ids and names. The UI never invents an option —
 * `session/request_permission` carries the only set the agent will accept, and answering with an
 * `optionId` it did not offer is answering a different question (S12 Step 4).
 *
 * `toolCallId` is what ties this live request to the projected `permission` item, whose entity key
 * is that same id: the pending list says what may be answered NOW, the projection says what the
 * answer turned out to be.
 */
export interface PendingPermissionView {
  readonly permissionId: string
  readonly toolCallId: string | null
  readonly title: string
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string | null }[]
}

/** The permission request's own words. Anything missing stays missing — a placeholder here would be the UI inventing a choice. */
function permissionView(permissionId: string, params: unknown): PendingPermissionView {
  const record = (params ?? {}) as { toolCall?: { toolCallId?: unknown; title?: unknown }; options?: unknown }
  const toolCallId = typeof record.toolCall?.toolCallId === 'string' ? record.toolCall.toolCallId : null
  const title = typeof record.toolCall?.title === 'string' ? record.toolCall.title : (toolCallId ?? permissionId)
  const options = (Array.isArray(record.options) ? record.options : [])
    .map((option) => option as { optionId?: unknown; name?: unknown; kind?: unknown })
    .filter((option): option is { optionId: string; name?: unknown; kind?: unknown } => typeof option.optionId === 'string')
    .map((option) => ({
      optionId: option.optionId,
      name: typeof option.name === 'string' ? option.name : option.optionId,
      kind: typeof option.kind === 'string' ? option.kind : null,
    }))
  return { permissionId, toolCallId, title, options }
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
  readonly #configReadback: ReadonlyMap<string, 'resume' | 'set-config-noop'> | undefined

  constructor(options: ChannelManagerOptions) {
    this.#pool = options.pool
    this.#nowSql = options.nowSql ?? 'now()'
    this.#logger = options.logger ?? (() => {})
    this.#connector = options.connector ?? new DevChannelConnector(options.promptDelayMs)
    this.#configReadback = options.configReadback
  }

  /** Whether THIS Workstream's harness re-attaches with `session/resume` (see `configReadback`). Absent knowledge resumes, which is the S8 behaviour. */
  async #attachesByResume(workstreamId: string): Promise<boolean> {
    const readback = this.#configReadback
    if (readback === undefined || readback.size === 0) return true
    const intent = (await loadLatestIntentEvent(this.#pool, workstreamId))?.intent as { harness?: unknown } | undefined
    const harness = typeof intent?.harness === 'string' ? intent.harness : undefined
    return harness === undefined || (readback.get(harness) ?? 'resume') === 'resume'
  }

  pendingPermissionIds(workstreamId: string): readonly string[] {
    return [...(this.#channels.get(workstreamId)?.pendingPermissions.keys() ?? [])]
  }

  /** The pending requests with the options the agent offered — what an operator needs to answer one. */
  pendingPermissions(workstreamId: string): readonly PendingPermissionView[] {
    return [...(this.#channels.get(workstreamId)?.pendingPermissions.values() ?? [])].map((pending) => pending.view)
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
          pendingPermissions.set(id, { id, view: permissionView(id, params), resolve })
        })
        void decision.then(() => pendingPermissions.delete(id))
        return decision
      },
    })
    channel.connection = connection
    // `initialize` is deliberately NOT sent here. It is a PROCESS-level handshake the harness bridge
    // performs once when it spawns the adapter (packages/harness-bridge/src/handshake.ts): codex-acp
    // answers a second one with "Already initialized", and both pinned adapters accept `session/*` on a
    // connection that never initialized — so re-initializing per verb bought nothing and broke one of
    // the two harnesses.
    channel.acpSessionId =
      connected.existingContextId !== undefined
        ? (await this.#attachesByResume(workstreamId))
          ? await resumeExistingContext(connection, connected.existingContextId)
          : connected.existingContextId
        : ((await connection.agent.request(acp.methods.agent.session.new, { cwd: workspaceRoot(), mcpServers: [] })) as { sessionId: string }).sessionId

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

  /**
   * Answers a pending request with one of the options the agent OFFERED. An `optionId` that is not
   * in that set is refused rather than forwarded: the agent asked a closed question, and sending it
   * an answer it never listed is a protocol violation whose handling is the agent's business, not
   * something to discover in production. (A request that offered no options at all is answered as
   * asked — that is the agent's own shape, not an invented one.)
   */
  decidePermission(workstreamId: string, permissionId: string, optionId: string): 'decided' | 'unknown' | 'not_offered' {
    const pending = this.#channels.get(workstreamId)?.pendingPermissions.get(permissionId)
    if (pending === undefined) return 'unknown'
    const offered = pending.view.options
    if (offered.length > 0 && !offered.some((option) => option.optionId === optionId)) return 'not_offered'
    pending.resolve({ outcome: { outcome: 'selected', optionId } })
    return 'decided'
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
  await connection.agent.request(acp.methods.agent.session.resume, { sessionId: contextId, cwd: workspaceRoot(), mcpServers: [] })
  return contextId
}

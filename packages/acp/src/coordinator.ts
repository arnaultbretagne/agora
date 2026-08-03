import * as acp from '@agentclientprotocol/sdk'
import type pg from 'pg'
import {
  assertPromptCardinalityAllowed,
  type CommandActorKind,
  type CommandState,
  type DurableCommand,
  type WorkstreamCategory,
} from '@agora/domain'
import {
  bindAcpSession,
  bindCapabilities,
  createOrReuseCommand,
  transitionCommandState,
  transitionSessionPhase,
} from '@agora/store-pg'
import { assertSafeMcpServers } from './mcp-guard.js'
import { journalDuplexStream, type DuplexByteStream } from './journaling-stream.js'
import { createStorePersist, type StorePersist } from './store-persist.js'

export interface BootstrapSessionInput {
  readonly pool: pg.Pool
  readonly workstreamId: string
  readonly sessionId: string
  readonly stream: DuplexByteStream
  readonly cwd: string
  /**
   * Already-resolved capability facts (ADR 0010/P08 Broker territory — not resolved here). This
   * plan only persists them in the right order: docs/specs/03 "New Session" binds capabilities
   * (step 3) BEFORE the phase advances to `provisioning` (step 5); the DB enforces this via
   * `sessions_check3` (no CHECK trigger validates transition legality, but this one does gate on
   * capability_digest being non-null outside {requested, failed}).
   */
  readonly capabilityPolicyVersion: string
  readonly capabilityDigest: Uint8Array
  readonly mcpServers?: readonly acp.McpServer[]
  readonly clientCapabilities?: acp.ClientCapabilities
  /**
   * docs/specs/04 "Permission policy MAY auto-decide only rules explicitly authorized by the
   * Session's grants; otherwise the request is surfaced ... and remains pending". No grants
   * system is wired yet (ADR 0010/P08), so the default fails closed to `cancelled`.
   */
  readonly onPermissionRequest?: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>
  readonly now?: () => Date
}

export interface BootstrapSessionResult {
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
  readonly protocolVersion: number
  /** Threaded into `promptSession`/`cancelSession` so inbound updates correlate to the right command. */
  readonly storePersist: StorePersist
}

const DEFAULT_CLIENT_CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
}

function methodNotSupported<Response>(method: string): () => Response {
  return () => {
    throw acp.RequestError.methodNotFound(method)
  }
}

/**
 * docs/specs/04-acp-integration.md "Connection bootstrap": initialize -> session/new -> bind the
 * Agent-returned sessionId exactly once. Any failure before binding completes leaves the Session
 * `failed` and unbound — never a silent fallback rebind (docs/specs/03 "New Session").
 */
export async function bootstrapSession(input: BootstrapSessionInput): Promise<BootstrapSessionResult> {
  const now = input.now ?? (() => new Date())
  const mcpServers = input.mcpServers ?? []
  assertSafeMcpServers(mcpServers)

  const storePersist = createStorePersist({ pool: input.pool, workstreamId: input.workstreamId, sessionId: input.sessionId })
  const journaled = journalDuplexStream(input.stream, storePersist.persist)
  const wire = acp.ndJsonStream(journaled.writable, journaled.readable)

  const clientApp = acp
    .client({ name: 'agora-control-plane' })
    .onNotification(acp.methods.client.session.update, () => {})
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      if (input.onPermissionRequest) return input.onPermissionRequest(params)
      return { outcome: { outcome: 'cancelled' } }
    })
    .onRequest(acp.methods.client.fs.readTextFile, methodNotSupported(acp.methods.client.fs.readTextFile))
    .onRequest(acp.methods.client.fs.writeTextFile, methodNotSupported(acp.methods.client.fs.writeTextFile))
    .onRequest(acp.methods.client.terminal.create, methodNotSupported(acp.methods.client.terminal.create))
    .onRequest(acp.methods.client.terminal.output, methodNotSupported(acp.methods.client.terminal.output))
    .onRequest(acp.methods.client.terminal.release, methodNotSupported(acp.methods.client.terminal.release))
    .onRequest(acp.methods.client.terminal.waitForExit, methodNotSupported(acp.methods.client.terminal.waitForExit))
    .onRequest(acp.methods.client.terminal.kill, methodNotSupported(acp.methods.client.terminal.kill))

  const connection = clientApp.connect(wire)

  async function failClosed(code: string, error: unknown): Promise<never> {
    const client = await input.pool.connect()
    try {
      await transitionSessionPhase(client, input.sessionId, 'failed', {
        failureCode: code,
        failureDetail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      client.release()
    }
    throw error
  }

  // docs/specs/03 "New Session" step 3: capability facts bind before the phase leaves
  // {requested, failed} — before initialize/session.new, not just before "provisioning".
  {
    const client = await input.pool.connect()
    try {
      await bindCapabilities(client, input.sessionId, input.capabilityPolicyVersion, input.capabilityDigest)
    } finally {
      client.release()
    }
  }

  let initializeResponse: acp.InitializeResponse
  try {
    initializeResponse = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: input.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
    })
  } catch (error) {
    return failClosed('acp_initialize_failed', error)
  }

  {
    const client = await input.pool.connect()
    try {
      await transitionSessionPhase(client, input.sessionId, 'provisioning')
    } finally {
      client.release()
    }
  }

  let newSessionResponse: acp.NewSessionResponse
  try {
    newSessionResponse = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: [...mcpServers],
    })
  } catch (error) {
    // Lost/failed response to session/new: fail closed. The Agora Session id is never reused and
    // no fallback binding is invented (docs/specs/03 "Any failure before ACP binding completes...").
    return failClosed('acp_session_new_failed', error)
  }

  const client = await input.pool.connect()
  try {
    await bindAcpSession(client, input.sessionId, newSessionResponse.sessionId, now(), {
      protocolVersion: initializeResponse.protocolVersion,
      capabilities: initializeResponse.agentCapabilities ?? {},
    })
    await transitionSessionPhase(client, input.sessionId, 'ready')
  } finally {
    client.release()
  }

  return {
    connection,
    acpSessionId: newSessionResponse.sessionId,
    protocolVersion: initializeResponse.protocolVersion,
    storePersist,
  }
}

export interface PromptSessionActor {
  readonly kind: CommandActorKind
  readonly id: string
}

export interface PromptSessionInput {
  readonly pool: pg.Pool
  readonly workstreamId: string
  readonly sessionId: string
  readonly connection: acp.ClientConnection
  readonly storePersist: StorePersist
  readonly acpSessionId: string
  readonly prompt: readonly acp.ContentBlock[]
  readonly purpose: 'user' | 'handoff'
  readonly actor: PromptSessionActor
  readonly idempotencyKey: string
  readonly now?: () => Date
}

export type PromptSessionResult =
  | { readonly outcome: 'completed'; readonly stopReason: string }
  | { readonly outcome: 'already_dispatched'; readonly state: CommandState }
  | { readonly outcome: 'unknown' }

/**
 * The durable command dispatcher (docs/specs/13-failure-and-idempotency.md "Command states" +
 * "ACP session/prompt: no blind retry after possible acceptance; preserve command as unknown").
 * A "duplicate dispatcher wakeup" (same idempotency key, command already past `accepted`) never
 * resends — it is detected here and returned as `already_dispatched` without calling the Agent.
 */
export async function promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
  const now = input.now ?? (() => new Date())

  const setupClient = await input.pool.connect()
  let command: DurableCommand
  try {
    const { rows: existingRows } = await setupClient.query<{ id: string }>(
      'SELECT id FROM product.commands WHERE workstream_id = $1 AND idempotency_scope = $2 AND idempotency_key = $3',
      [input.workstreamId, 'prompt', input.idempotencyKey],
    )
    const alreadyAccepted = existingRows.length > 0

    // Cardinality is enforced once, at first acceptance — a retry of the SAME command must not
    // be re-blocked by its own prior acceptance (docs/specs/13: "acceptance", not every retry).
    if (!alreadyAccepted && input.purpose === 'user') {
      const { rows: workstreamRows } = await setupClient.query<{ category: WorkstreamCategory }>(
        'SELECT category FROM product.workstreams WHERE id = $1',
        [input.workstreamId],
      )
      const workstream = workstreamRows[0]
      if (!workstream) throw new Error(`workstream ${input.workstreamId} not found`)
      const { rows: countRows } = await setupClient.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM product.commands
         WHERE workstream_id = $1 AND command_type = 'PromptSession' AND purpose = 'user'`,
        [input.workstreamId],
      )
      assertPromptCardinalityAllowed(workstream.category, 'user', countRows[0]?.n ?? 0)
    }

    command = await createOrReuseCommand(setupClient, {
      type: 'PromptSession',
      workstreamId: input.workstreamId as never,
      sessionId: input.sessionId as never,
      actor: { kind: input.actor.kind, id: input.actor.id as never },
      idempotencyScope: 'prompt',
      idempotencyKey: input.idempotencyKey,
      purpose: input.purpose,
      acceptedAt: now(),
      request: { prompt: input.prompt },
    })
  } finally {
    setupClient.release()
  }

  if (command.state !== 'accepted') {
    return { outcome: 'already_dispatched', state: command.state }
  }

  const dispatchClient = await input.pool.connect()
  try {
    await transitionCommandState(dispatchClient, command.id, 'dispatching', now())
  } finally {
    dispatchClient.release()
  }

  // Marks BOTH directions (the outbound request AND every inbound session/update it triggers) as
  // belonging to this command until cleared — see store-persist.ts for why this must be explicit
  // mutable state rather than AsyncLocalStorage (inbound frames arrive via a separate async chain
  // driven by the stream's own read loop, which does not inherit the outbound call's context).
  input.storePersist.setInFlightCommand(command.id, input.purpose)

  let response: acp.PromptResponse
  try {
    response = await input.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: input.acpSessionId,
      prompt: [...input.prompt],
    })
  } catch (error) {
    // Ambiguous delivery: the request may have reached the Agent. Never blind-retry; mark unknown
    // for operation-specific reconciliation (docs/specs/13 "Prompt delivery ambiguity").
    const client = await input.pool.connect()
    try {
      await transitionCommandState(client, command.id, 'unknown', now(), {
        code: 'prompt_delivery_unknown',
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      client.release()
      input.storePersist.setInFlightCommand(undefined, undefined)
    }
    return { outcome: 'unknown' }
  }
  input.storePersist.setInFlightCommand(undefined, undefined)

  const client = await input.pool.connect()
  try {
    await transitionCommandState(client, command.id, 'acknowledged', now())
    await transitionCommandState(client, command.id, 'completed', now())
  } finally {
    client.release()
  }

  return { outcome: 'completed', stopReason: response.stopReason }
}

export interface CancelSessionInput {
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
}

/** `session/cancel` is advisory — the journal keeps accepting valid final updates after this. */
export async function cancelSession(input: CancelSessionInput): Promise<void> {
  await input.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: input.acpSessionId })
}

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
  /**
   * What this Agent advertised it can be configured with, verbatim from its `session/new` response
   * (`undefined` when it advertised nothing — the field is optional in ACP).
   *
   * Returned rather than left to be excavated from the journal because the caller needs it for two
   * things the journal cannot serve in time: applying the operator's pending choices before the
   * first prompt, and recording what this Agent offers so the NEXT conversation's composer can show
   * a list before any Runtime exists (P12).
   */
  readonly configOptions?: readonly acp.SessionConfigOption[]
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
 * Answers the Agent's tool-permission requests without a human in the loop.
 *
 * There is nobody to ask. A Session Runtime runs unattended, so the previous behaviour — replying
 * `cancelled` whenever no handler was supplied, which was always — aborted every single tool call
 * the Agent ever attempted. Found live 2026-08-07: `claude-code` could not run so much as `bash`,
 * reporting "Tool use aborted" for everything.
 *
 * Approving is the architecture's own answer, not a shortcut around it. agent-runtime ADR 0003 is
 * "libre dedans, borné dehors": a Session Runtime Pod is gVisor-sandboxed, runs non-root, holds no
 * Kubernetes token, has an ephemeral per-Pod `emptyDir` for a workspace, cannot reach providers or
 * the Internet except through the Broker relay, and cannot see product Postgres or another
 * Session's custody. The permission prompt is a harness affordance designed for a developer's own
 * machine, where the blast radius is that machine. Here the blast radius is the sandbox, and the
 * sandbox is the boundary — which is why the OLD system launched its runtimes with
 * `--dangerously-skip-permissions` for the same reason, and why this one still passes that flag.
 *
 * `allow_always` is preferred over `allow_once` purely to save round trips; both mean the same
 * thing here. `cancelled` survives as the answer when the Agent offers no allow option at all,
 * because inventing one would be answering a question that was not asked.
 *
 * A caller that DOES have somewhere to put the question — a durable pending-request model and a UI
 * to decide it — supplies `onPermissionRequest` and this is never reached.
 */
export function autoApprove(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const options = params.options ?? []
  const chosen = options.find((option) => option.kind === 'allow_always') ?? options.find((option) => option.kind === 'allow_once')
  if (!chosen) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } }
}

interface ClientAppOptions {
  readonly onPermissionRequest?: ((params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>) | undefined
}

/** The Client-side handler set is identical whether this connection is for a new Session or a resume — shared so the two never silently drift. */
function buildClientApp(options: ClientAppOptions): acp.ClientApp {
  return acp
    .client({ name: 'agora-control-plane' })
    .onNotification(acp.methods.client.session.update, () => {})
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      if (options.onPermissionRequest) return options.onPermissionRequest(params)
      return autoApprove(params)
    })
    .onRequest(acp.methods.client.fs.readTextFile, methodNotSupported(acp.methods.client.fs.readTextFile))
    .onRequest(acp.methods.client.fs.writeTextFile, methodNotSupported(acp.methods.client.fs.writeTextFile))
    .onRequest(acp.methods.client.terminal.create, methodNotSupported(acp.methods.client.terminal.create))
    .onRequest(acp.methods.client.terminal.output, methodNotSupported(acp.methods.client.terminal.output))
    .onRequest(acp.methods.client.terminal.release, methodNotSupported(acp.methods.client.terminal.release))
    .onRequest(acp.methods.client.terminal.waitForExit, methodNotSupported(acp.methods.client.terminal.waitForExit))
    .onRequest(acp.methods.client.terminal.kill, methodNotSupported(acp.methods.client.terminal.kill))
}

/** Shared fail-closed transition: any failure before the caller's own ACP handshake completes leaves the Session in a typed `failed` state, never a silent retry or fallback. */
function failClosedTransition(pool: pg.Pool, sessionId: string): (code: string, error: unknown) => Promise<never> {
  return async (code, error) => {
    const client = await pool.connect()
    try {
      await transitionSessionPhase(client, sessionId, 'failed', {
        failureCode: code,
        failureDetail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      client.release()
    }
    throw error
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

  const clientApp = buildClientApp({ onPermissionRequest: input.onPermissionRequest })
  const connection = clientApp.connect(wire)
  const failClosed = failClosedTransition(input.pool, input.sessionId)

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
    ...(newSessionResponse.configOptions ? { configOptions: newSessionResponse.configOptions } : {}),
  }
}

export interface ResumeAcpSessionInput {
  readonly pool: pg.Pool
  readonly workstreamId: string
  readonly sessionId: string
  readonly stream: DuplexByteStream
  readonly cwd: string
  /** The ORIGINAL ACP Session id, bound once at first bootstrap (`bindAcpSession` is write-once) — resume reuses it, it never rebinds. */
  readonly acpSessionId: string
  readonly clientCapabilities?: acp.ClientCapabilities
  readonly onPermissionRequest?: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>
}

export interface ResumeAcpSessionResult {
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
  readonly storePersist: StorePersist
  /** Same role as `BootstrapSessionResult.configOptions`: `session/resume` reports the resumed Session's option set, and a resumed Session is exactly where the operator's pending choices have to be re-asserted (P12). */
  readonly configOptions?: readonly acp.SessionConfigOption[]
}

/**
 * docs/specs/03 "Resume": a fresh ACP connection to the (rematerialized) Pod, `initialize` ->
 * verify `agentCapabilities.session.resume` -> `session/resume` with the SAME Agora-known ACP
 * Session id (never a new one — ADR 0005 "Pod replacement may produce a new Pod UID without a new
 * Session/runtime identity"). `session/resume` deliberately never replays prior messages (unlike
 * `session/load`) — the journal is this system's own replay mechanism; a second replica of history
 * from the Agent side would risk duplicate Workstream items, which this plan explicitly avoids.
 */
export async function resumeAcpSession(input: ResumeAcpSessionInput): Promise<ResumeAcpSessionResult> {
  const storePersist = createStorePersist({ pool: input.pool, workstreamId: input.workstreamId, sessionId: input.sessionId })
  const journaled = journalDuplexStream(input.stream, storePersist.persist)
  const wire = acp.ndJsonStream(journaled.writable, journaled.readable)

  const clientApp = buildClientApp({ onPermissionRequest: input.onPermissionRequest })
  const connection = clientApp.connect(wire)
  const failClosed = failClosedTransition(input.pool, input.sessionId)

  let initializeResponse: acp.InitializeResponse
  try {
    initializeResponse = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: input.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
    })
  } catch (error) {
    return failClosed('acp_initialize_failed', error)
  }

  if (!initializeResponse.agentCapabilities?.sessionCapabilities?.resume) {
    return failClosed('acp_resume_not_supported', new Error("Agent does not advertise the 'session.resume' capability"))
  }

  let resumeResponse: acp.ResumeSessionResponse
  try {
    resumeResponse = await connection.agent.request(acp.methods.agent.session.resume, { sessionId: input.acpSessionId, cwd: input.cwd })
  } catch (error) {
    // docs/specs/13 "Compatibility": never pretend native resume succeeded — fail closed, typed,
    // no fallback to a new Session invented here (the caller decides whether to offer that).
    return failClosed('acp_session_resume_failed', error)
  }

  const client = await input.pool.connect()
  try {
    await transitionSessionPhase(client, input.sessionId, 'ready')
  } finally {
    client.release()
  }

  return {
    connection,
    acpSessionId: input.acpSessionId,
    storePersist,
    ...(resumeResponse?.configOptions ? { configOptions: resumeResponse.configOptions } : {}),
  }
}

export interface PromptSessionActor {
  readonly kind: CommandActorKind
  readonly id: string
}

export interface PromptSessionHandoffSource {
  readonly sourceFromSeq: number
  readonly sourceThroughSeq: number
  readonly seedPolicyVersion: string
  readonly contentSha256: Uint8Array
  /** docs/specs/06 "Source range exceeds size policy": whether the built content is complete or a bounded manifest/preview. Not part of the domain's typed HandoffSourceRange — stored in the command's own request payload, read back by the projector via SQL. */
  readonly fidelity: 'complete' | 'degraded'
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
  /** Required when, and only meaningful when, `purpose === 'handoff'`. */
  readonly handoffSource?: PromptSessionHandoffSource
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
      request: input.handoffSource ? { prompt: input.prompt, fidelity: input.handoffSource.fidelity } : { prompt: input.prompt },
      ...(input.handoffSource
        ? {
            handoffSource: {
              sourceFromSeq: input.handoffSource.sourceFromSeq,
              sourceThroughSeq: input.handoffSource.sourceThroughSeq,
              seedPolicyVersion: input.handoffSource.seedPolicyVersion,
              contentSha256: input.handoffSource.contentSha256,
            },
          }
        : {}),
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

export interface SetSessionConfigOptionInput {
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
  /** The option's own id as the Agent advertised it (e.g. `model`, `effort`) — never a value this codebase invents. */
  readonly optionId: string
  /** A select option's value id, or a boolean option's state — ACP's request is a union over the two. */
  readonly value: string | boolean
}

/**
 * docs/specs/04 leaves ACP mode/config methods to the harness: which options exist, what values
 * they accept, and how one affects another are the Agent's own facts, not ours. The OLD
 * channels-era system offered exactly two of them as first-class product choices — the model and
 * the reasoning effort — so the replacement surface needs a way to set them.
 *
 * Deliberately pass-through: this takes the option id and value the Agent itself advertised in its
 * `session/new` response and hands them straight back. It does NOT curate a model list, because a
 * curated list goes stale the moment the harness ships a new one — the old system had the same
 * shape (its model catalogue came from the runtime's own capabilities endpoint, never a constant).
 *
 * The response carries the FULL option set back, because changing one option may change what the
 * others accept — callers should replace their whole view of the options with what comes back
 * rather than patching the one they set.
 */
export async function setSessionConfigOption(input: SetSessionConfigOptionInput): Promise<unknown> {
  return input.connection.agent.request(acp.methods.agent.session.setConfigOption, {
    sessionId: input.acpSessionId,
    // ACP calls this `configId` (the SDK's own typed request shape) — the product surface says
    // "config option", so the mapping is made here once rather than leaking the protocol's name.
    configId: input.optionId,
    // A discriminated union, not a plain field: `SetSessionConfigOptionRequest` is
    // `{value: boolean, type: 'boolean'} | {value: SessionConfigValueId}`. A boolean option set
    // without its `type` discriminator is a select-shaped request carrying the wrong kind of value,
    // which the Agent is entitled to reject — so the discriminator travels with the value.
    ...(typeof input.value === 'boolean' ? { value: input.value, type: 'boolean' as const } : { value: input.value }),
  })
}

export interface SetSessionModeInput {
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
  /** One of the mode ids the Agent advertised (e.g. `default`, `plan`, `acceptEdits`). */
  readonly modeId: string
}

/** Companion to `setSessionConfigOption` for ACP's separate session-mode channel (`session/set_mode`). */
export async function setSessionMode(input: SetSessionModeInput): Promise<unknown> {
  return input.connection.agent.request(acp.methods.agent.session.setMode, {
    sessionId: input.acpSessionId,
    modeId: input.modeId,
  })
}

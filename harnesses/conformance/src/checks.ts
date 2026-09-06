// The runnable conformance checks. Every one of them drives the harness's real ACP surface through
// packages/acp's own client wiring — the same capture/framing path production uses, so a framing
// bug shows up here rather than in a Pod. A check never guesses: what it cannot establish it
// reports as `skipped` with the reason (missing credentials, no relay configured, would spend real
// model usage without an explicit opt-in), never as a pass and never as a failure of the harness.
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, initializeParams, type DuplexByteStream } from '@agora/acp'
import type { ConformanceRowId } from './table.js'
import type { ConformanceTarget, TargetConnection } from './target.js'

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface CheckResult {
  readonly id: string
  readonly row: ConformanceRowId
  readonly status: CheckStatus
  readonly detail: string
}

export interface ConnectionOptions {
  /** Collects `session/update` notifications for the duration of this connection. */
  readonly onSessionUpdate?: (params: unknown) => void
}

export interface CheckContext {
  readonly target: ConformanceTarget
  /** Opens a connection, runs the body, and always closes it — the harness process itself is untouched. */
  withConnection<T>(body: (connection: acp.ClientConnection) => Promise<T>, options?: ConnectionOptions): Promise<T>
}

interface ConfigOption {
  readonly id: string
  readonly currentValue?: unknown
  readonly options?: readonly { readonly value?: unknown }[]
}

interface NewSessionResponse {
  readonly sessionId: string
  readonly configOptions?: readonly ConfigOption[]
}

/** No journal here: the suite proves frames are well-formed and capturable, not that they were stored. */
function noopPersist(): (direction: 'client_to_agent' | 'agent_to_client', frameText: string) => Promise<{ seq: number; observationId: string }> {
  let seq = 0
  return async () => {
    seq += 1
    return { seq, observationId: `conformance-${String(seq)}` }
  }
}

export function connectionFactory(target: ConformanceTarget): CheckContext['withConnection'] {
  return async function withConnection<T>(body: (connection: acp.ClientConnection) => Promise<T>, options?: ConnectionOptions): Promise<T> {
    const opened: TargetConnection = await target.connect()
    const stream: DuplexByteStream = opened.stream
    const connection = buildClientConnection(stream, noopPersist(), options?.onSessionUpdate === undefined ? {} : { onSessionUpdate: options.onSessionUpdate })
    try {
      return await body(connection)
    } finally {
      connection.close()
      await opened.close()
    }
  }
}

async function initialize(connection: acp.ClientConnection, target: ConformanceTarget): Promise<Record<string, unknown>> {
  return (await connection.agent.request(acp.methods.agent.initialize, initializeParams(target.workspaceRoot))) as Record<string, unknown>
}

async function newSession(connection: acp.ClientConnection, target: ConformanceTarget): Promise<NewSessionResponse> {
  return (await connection.agent.request(acp.methods.agent.session.new, { cwd: target.workspaceRoot, mcpServers: [] })) as NewSessionResponse
}

function optionOf(response: { configOptions?: readonly ConfigOption[] }, id: string): ConfigOption | undefined {
  return response.configOptions?.find((option) => option.id === id)
}

function pass(id: string, row: ConformanceRowId, detail: string): CheckResult {
  return { id, row, status: 'pass', detail }
}
function fail(id: string, row: ConformanceRowId, detail: string): CheckResult {
  return { id, row, status: 'fail', detail }
}
function skip(id: string, row: ConformanceRowId, detail: string): CheckResult {
  return { id, row, status: 'skipped', detail }
}

export type Check = (context: CheckContext) => Promise<CheckResult>

/** Launch and identity: the negotiated protocol is the pinned stable v1, not whatever the peer prefers. */
export const protocolVersionCheck: Check = async ({ target, withConnection }) => {
  const id = 'identity/protocol-version'
  const row: ConformanceRowId = 'launch-and-identity'
  const result = await withConnection((connection) => initialize(connection, target))
  const negotiated = result['protocolVersion']
  const expected = target.expected.protocolVersion ?? acp.PROTOCOL_VERSION
  return negotiated === expected
    ? pass(id, row, `negotiated protocol version ${String(negotiated)}`)
    : fail(id, row, `negotiated ${String(negotiated)}, expected ${String(expected)}`)
}

/** Launch and identity: the image really carries the adapter the reviewed catalogue pinned. */
export const agentIdentityCheck: Check = async ({ target, withConnection }) => {
  const id = 'identity/agent-info'
  const row: ConformanceRowId = 'launch-and-identity'
  const result = await withConnection((connection) => initialize(connection, target))
  const info = (result['agentInfo'] ?? {}) as { name?: string; version?: string }
  if (target.expected.adapterName === undefined && target.expected.adapterVersion === undefined) {
    return skip(id, row, `no pinned identity to compare against; observed ${String(info.name)}@${String(info.version)}`)
  }
  const nameOk = target.expected.adapterName === undefined || info.name === target.expected.adapterName
  const versionOk = target.expected.adapterVersion === undefined || info.version === target.expected.adapterVersion
  return nameOk && versionOk
    ? pass(id, row, `${String(info.name)}@${String(info.version)} matches the pinned identity`)
    : fail(id, row, `observed ${String(info.name)}@${String(info.version)}, pinned ${String(target.expected.adapterName)}@${String(target.expected.adapterVersion)}`)
}

/**
 * Launch and identity: every capability Agora's own integration depends on must be advertised —
 * `loadSession` for prompt delivery recovery (S8 Step 5), `session.resume` for configuration
 * readback, `session.list` for START's discovery of a lost `session/new`. A harness missing any of
 * them cannot be enabled, because the corresponding evidence would have to be invented instead.
 */
export const requiredCapabilitiesCheck: Check = async ({ target, withConnection }) => {
  const id = 'identity/required-capabilities'
  const row: ConformanceRowId = 'launch-and-identity'
  const result = await withConnection((connection) => initialize(connection, target))
  const capabilities = (result['agentCapabilities'] ?? {}) as { loadSession?: unknown; sessionCapabilities?: Record<string, unknown> }
  const missing: string[] = []
  if (capabilities.loadSession !== true) missing.push('agentCapabilities.loadSession')
  for (const capability of ['resume', 'list']) {
    if (capabilities.sessionCapabilities?.[capability] === undefined) missing.push(`sessionCapabilities.${capability}`)
  }
  return missing.length === 0
    ? pass(id, row, 'loadSession, sessionCapabilities.resume and sessionCapabilities.list are all advertised')
    : fail(id, row, `missing: ${missing.join(', ')}`)
}

/**
 * Launch and identity, stable correlation: a second connection reaches the SAME harness process, so
 * a context created on one connection is reachable from the next. This is the property the bridge
 * server promises ("the adapter process outlives any single WebSocket connection") and the one
 * START's rebind and Step 5's recovery actually depend on. Reachability is tested with
 * `session/resume`, NOT with `session/list` — see the discovery check below for why those are not
 * the same question.
 */
export const sameProcessAcrossConnectionsCheck: Check = async ({ target, withConnection }) => {
  const id = 'identity/same-process-across-connections'
  const row: ConformanceRowId = 'launch-and-identity'
  let sessionId: string
  try {
    sessionId = await withConnection(async (connection) => {
      await initialize(connection, target)
      return (await newSession(connection, target)).sessionId
    })
  } catch (error) {
    return skip(id, row, `could not open a session to correlate: ${describe(error)}`)
  }
  try {
    await withConnection(async (connection) => {
      await initialize(connection, target)
      await connection.agent.request(acp.methods.agent.session.resume, { sessionId, cwd: target.workspaceRoot, mcpServers: [] })
    })
    return pass(id, row, `the context ${sessionId} created on one connection is reachable from another`)
  } catch (error) {
    return fail(id, row, `the context ${sessionId} is not reachable from a second connection: ${describe(error)}`)
  }
}

/**
 * Launch and identity, discovery after a lost `session/new`: START's unknown-acceptance recovery
 * discovers an already-created context with `session/list` rather than blindly creating a second
 * one. That only works if a context with NO content yet is listed — which is exactly the state a
 * lost `session/new` response leaves behind.
 *
 * Measured on claude-agent-acp 0.75.1: it is NOT. An empty context is reachable by
 * `session/resume`/`session/load` but absent from `session/list` until it has content, so the
 * orphan of a lost `session/new` cannot be discovered through the standard surface at all. The
 * check reports that as a skip naming the consequence rather than a pass, so if a harness (or a
 * later adapter version) does list empty contexts, this turns into a pass and the discovery hole
 * closes on its own.
 */
export const emptyContextDiscoverableCheck: Check = async ({ target, withConnection }) => {
  const id = 'discovery/empty-context-is-listed'
  const row: ConformanceRowId = 'launch-and-identity'
  let sessionId: string
  try {
    sessionId = await withConnection(async (connection) => {
      await initialize(connection, target)
      return (await newSession(connection, target)).sessionId
    })
  } catch (error) {
    return skip(id, row, `could not open a session to look for: ${describe(error)}`)
  }
  const listed = await withConnection(async (connection) => {
    await initialize(connection, target)
    return (await connection.agent.request(acp.methods.agent.session.list, { cwd: target.workspaceRoot })) as {
      sessions?: readonly { sessionId?: string }[]
    }
  })
  return listed.sessions?.some((session) => session.sessionId === sessionId) === true
    ? pass(id, row, 'a context with no content is listed, so a lost session/new is fully discoverable')
    : skip(
        id,
        row,
        'a context with no content is NOT listed (it is still reachable by resume/load): the orphan of a lost session/new cannot be discovered, so START creates a fresh context and leaves an empty, unattributed one behind',
      )
}

/** Configuration and bootstrap: model and effort are real, selectable options with a current value. */
export const configOptionsPresentCheck: Check = async ({ target, withConnection }) => {
  const id = 'config/model-and-effort-options'
  const row: ConformanceRowId = 'configuration-and-bootstrap'
  let session: NewSessionResponse
  try {
    session = await withConnection(async (connection) => {
      await initialize(connection, target)
      return newSession(connection, target)
    })
  } catch (error) {
    return skip(id, row, `could not open a session: ${describe(error)}`)
  }
  const model = optionOf(session, 'model')
  const effort = optionOf(session, 'effort')
  const problems: string[] = []
  if (model === undefined) problems.push('no `model` config option')
  else if (typeof model.currentValue !== 'string') problems.push('`model` has no currentValue')
  if (effort === undefined) problems.push('no `effort` config option')
  else if (typeof effort.currentValue !== 'string') problems.push('`effort` has no currentValue')
  return problems.length === 0
    ? pass(id, row, `model=${String(model?.currentValue)} effort=${String(effort?.currentValue)}`)
    : fail(id, row, problems.join('; '))
}

/**
 * Configuration and bootstrap, SESSION-A08: the harness must report the value it ACTUALLY holds,
 * both in the mutation's own response and on a later resume — never echo the request back and
 * never report the creation default after a change.
 */
export const truthfulReadbackCheck: Check = async ({ target, withConnection }) => {
  const id = 'config/truthful-readback'
  const row: ConformanceRowId = 'configuration-and-bootstrap'
  try {
    return await withConnection(async (connection) => {
      await initialize(connection, target)
      const session = await newSession(connection, target)
      const model = optionOf(session, 'model')
      const current = model?.currentValue
      const alternative = model?.options?.map((option) => option.value).find((value) => typeof value === 'string' && value !== current)
      if (typeof alternative !== 'string') {
        return skip(id, row, 'the harness offers no second model value to change to')
      }
      const setResponse = (await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: 'model',
        value: alternative,
      })) as { configOptions?: readonly ConfigOption[] }
      const afterSet = optionOf(setResponse, 'model')?.currentValue
      if (afterSet !== alternative) {
        return fail(id, row, `set_config_option reported ${String(afterSet)} after setting ${alternative}`)
      }
      const resumed = (await connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: target.workspaceRoot,
        mcpServers: [],
      })) as { configOptions?: readonly ConfigOption[] }
      const afterResume = optionOf(resumed, 'model')?.currentValue
      return afterResume === alternative
        ? pass(id, row, `model reads back as ${alternative} both from the mutation and from resume`)
        : fail(id, row, `resume reported ${String(afterResume)} after the model was set to ${alternative} (SESSION-A08)`)
    })
  } catch (error) {
    return skip(id, row, `could not exercise configuration: ${describe(error)}`)
  }
}

/**
 * Configuration and bootstrap: "missing/unsupported values never imply a substitute default"
 * (execution.md). An unsupported model must be refused, not silently replaced by something else —
 * a silent substitution would make CONFIG converge on a value the Intent never asked for.
 */
export const noSubstitutedDefaultCheck: Check = async ({ target, withConnection }) => {
  const id = 'config/no-substituted-default'
  const row: ConformanceRowId = 'configuration-and-bootstrap'
  try {
    return await withConnection(async (connection) => {
      await initialize(connection, target)
      const session = await newSession(connection, target)
      const before = optionOf(session, 'model')?.currentValue
      const unsupported = 'agora-conformance-model-that-does-not-exist'
      try {
        const response = (await connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'model',
          value: unsupported,
        })) as { configOptions?: readonly ConfigOption[] }
        const after = optionOf(response, 'model')?.currentValue
        if (after === unsupported) return fail(id, row, 'the harness accepted a model it never advertised')
        return fail(id, row, `an unsupported model was silently substituted (${String(before)} -> ${String(after)}) instead of refused`)
      } catch {
        return pass(id, row, 'an unsupported model value is refused rather than substituted')
      }
    })
  } catch (error) {
    return skip(id, row, `could not exercise configuration: ${describe(error)}`)
  }
}

/**
 * Configuration and bootstrap, dependent options: changing the model re-reports the effort options
 * that apply to the NEW model (P3 measured this resetting effort on the real adapter), which is why
 * `SET_MODEL` must settle before `SET_EFFORT` is attempted.
 */
export const dependentOptionsCheck: Check = async ({ target, withConnection }) => {
  const id = 'config/effort-options-follow-model'
  const row: ConformanceRowId = 'configuration-and-bootstrap'
  try {
    return await withConnection(async (connection) => {
      await initialize(connection, target)
      const session = await newSession(connection, target)
      const model = optionOf(session, 'model')
      const alternative = model?.options?.map((option) => option.value).find((value) => typeof value === 'string' && value !== model.currentValue)
      if (typeof alternative !== 'string') return skip(id, row, 'the harness offers no second model value to change to')
      const response = (await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: 'model',
        value: alternative,
      })) as { configOptions?: readonly ConfigOption[] }
      const effort = optionOf(response, 'effort')
      return effort !== undefined && typeof effort.currentValue === 'string'
        ? pass(id, row, `the model change re-reported effort (currentValue=${effort.currentValue})`)
        : fail(id, row, 'changing the model did not report the effort options that apply to it')
    })
  } catch (error) {
    return skip(id, row, `could not exercise configuration: ${describe(error)}`)
  }
}

/**
 * Quiescence and delivery: `session/cancel` is a NOTIFICATION in ACP — a harness must accept it
 * without a response and stay usable. (Agora sent it as a request for a whole slice before this was
 * checked; the connection simply waited forever for a reply that a notification never gets.)
 */
export const cancelIsANotificationCheck: Check = async ({ target, withConnection }) => {
  const id = 'delivery/cancel-accepted-as-notification'
  const row: ConformanceRowId = 'quiescence-and-delivery'
  try {
    return await withConnection(async (connection) => {
      await initialize(connection, target)
      const session = await newSession(connection, target)
      await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
      // The connection must still work afterwards: a peer that errored or closed on the
      // notification would fail here rather than silently look fine.
      await connection.agent.request(acp.methods.agent.session.resume, { sessionId: session.sessionId, cwd: target.workspaceRoot, mcpServers: [] })
      return pass(id, row, 'session/cancel is accepted as a notification and the connection stays usable')
    })
  } catch (error) {
    return skip(id, row, `could not exercise cancel: ${describe(error)}`)
  }
}

/**
 * Quiescence and delivery, unknown-acceptance recovery: `session/load` must replay the context's
 * own history so an ambiguous dispatch can be resolved WITHOUT a blind resend (S8 Step 5). Costs
 * one real model turn, so it only runs when the operator explicitly allows model spend.
 */
export const replayProvidesRecoveryEvidenceCheck: Check = async ({ target, withConnection }) => {
  const id = 'delivery/load-replays-history'
  const row: ConformanceRowId = 'quiescence-and-delivery'
  if (target.allowModelSpend !== true) {
    return skip(id, row, 'requires one real model turn; re-run with model spend explicitly allowed')
  }
  const canary = 'Reply with exactly the single word: PONG'
  try {
    const sessionId = await withConnection(async (connection) => {
      await initialize(connection, target)
      const session = await newSession(connection, target)
      await connection.agent.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: canary }] })
      return session.sessionId
    })

    const replayed: { role: 'user' | 'agent'; text: string }[] = []
    await withConnection(
      async (connection) => {
        await initialize(connection, target)
        await connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd: target.workspaceRoot, mcpServers: [] })
      },
      {
        onSessionUpdate: (params) => {
          const update = (params as { update?: { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } } } | null)?.update
          const text = update?.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : null
          if (text === null) return
          if (update?.sessionUpdate === 'user_message_chunk') replayed.push({ role: 'user', text })
          if (update?.sessionUpdate === 'agent_message_chunk') replayed.push({ role: 'agent', text })
        },
      },
    )

    const sawPrompt = replayed.some((message) => message.role === 'user' && message.text === canary)
    const sawReply = replayed.some((message) => message.role === 'agent')
    if (!sawPrompt) {
      return fail(id, row, `session/load replayed ${String(replayed.length)} message(s) but not the prompt itself — delivery could not be proven without a resend`)
    }
    return sawReply
      ? pass(id, row, 'session/load replays the prompt verbatim and its reply, so an ambiguous dispatch is resolvable without resending')
      : pass(id, row, 'session/load replays the prompt verbatim (no reply yet), which is already enough to refuse a blind resend')
  } catch (error) {
    return fail(id, row, `session/load could not provide recovery evidence: ${describe(error)}`)
  }
}

/** Isolation and OneCLI: only runnable when the target is reached through the Broker relay. */
export const relayIsolationCheck: Check = async ({ target }) => {
  const id = 'isolation/allowed-and-denied-provider-calls'
  const row: ConformanceRowId = 'isolation-and-onecli'
  if (target.relay === undefined) {
    return skip(id, row, 'no relay configured for this target; run the suite against a Pod behind the Broker relay')
  }
  return skip(id, row, 'the relay decision path is covered by apps/broker\'s own tests; an in-Pod egress probe belongs to the end-to-end run')
}

export const ALL_CHECKS: readonly Check[] = [
  protocolVersionCheck,
  agentIdentityCheck,
  requiredCapabilitiesCheck,
  sameProcessAcrossConnectionsCheck,
  emptyContextDiscoverableCheck,
  configOptionsPresentCheck,
  truthfulReadbackCheck,
  noSubstitutedDefaultCheck,
  dependentOptionsCheck,
  cancelIsANotificationCheck,
  replayProvidesRecoveryEvidenceCheck,
  relayIsolationCheck,
]

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

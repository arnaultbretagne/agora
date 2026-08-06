import { randomUUID } from 'node:crypto'
import * as acp from '@agentclientprotocol/sdk'

/**
 * Deterministic in-process fake ACP Agent (docs/specs, P00 global rule: "Use fake ACP Agents for
 * deterministic protocol tests"). Sane defaults for initialize/session.new; `onPrompt`/`onCancel`
 * are overridable per test so different scenarios (multi-chunk, permission requests, races) can
 * be scripted without a real harness.
 */
export interface FakeAgentOptions {
  readonly acpSessionId?: string
  readonly agentCapabilities?: Record<string, unknown>
  /** Override to simulate a failed/lost `session/new` response (e.g. `throw new Error(...)`). */
  readonly onSessionNew?: (
    params: acp.NewSessionRequest,
    context: acp.AgentRequestContext<acp.NewSessionRequest>,
  ) => Promise<acp.NewSessionResponse> | acp.NewSessionResponse
  readonly onPrompt?: (
    params: acp.PromptRequest,
    context: acp.AgentRequestContext<acp.PromptRequest>,
  ) => Promise<acp.PromptResponse> | acp.PromptResponse
  readonly onCancel?: (
    params: acp.CancelNotification,
    context: acp.AgentNotificationContext<acp.CancelNotification>,
  ) => Promise<void> | void
  /**
   * docs/specs/07-custody.md: the fake Agent's own opaque native format is entirely this file's
   * choice (no real Claude/Codex format exists to match). This is a caller-owned mutable cell, not
   * internal closure state, so a custody driver can read it for `capture` and seed it for
   * `restore` without this module knowing anything about bytes, checksums or transport.
   */
  readonly nativeState?: { current: FakeAgentNativeState | undefined }
}

/** The fake Agent's entire "harness state" — deliberately tiny and JSON, proving continuity across a Pod replacement without pretending to be a real transcript format. */
export interface FakeAgentNativeState {
  readonly acpSessionId: string
  readonly promptsSeen: number
  readonly lastMessages: readonly string[]
}

const MAX_REMEMBERED_MESSAGES = 5

function newConfigState() {
  // Per-agent, never module-level: several fake Agents live in one test process and must not share
  // a session's chosen model/effort with each other.
  const values = new Map<string, string>()
  let currentModeId = 'default'
  return {
    setOption: (id: string, value: string) => values.set(id, value),
    setMode: (id: string) => { currentModeId = id },
    options: () => FAKE_CONFIG_OPTIONS.map((o) => ({ ...o, currentValue: values.get(o.id) ?? o.options[0]!.value })),
    modes: () => ({ currentModeId, availableModes: FAKE_MODES }),
  }
}

export function createFakeAgent(options: FakeAgentOptions = {}): acp.AgentApp {
  const stateCell = options.nativeState ?? { current: undefined }
  const config = newConfigState()

  return acp
    .agent({ name: 'agora-fake-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: options.agentCapabilities ?? { loadSession: false, sessionCapabilities: { resume: {} } },
    }))
    .onRequest(acp.methods.agent.session.new, async (context) => {
      if (options.onSessionNew) return options.onSessionNew(context.params, context)
      // A UNIQUE id per session/new, like every real Agent — a fixed constant collided on
      // `sessions_agent_acp_session_id_unique` as soon as one test file opened two Sessions
      // against the same Agent identity (found live, P11). Tests that need a deterministic id
      // still pass `acpSessionId` explicitly.
      const sessionId = options.acpSessionId ?? `fake-acp-session-${randomUUID()}`
      stateCell.current = { acpSessionId: sessionId, promptsSeen: 0, lastMessages: [] }
      // Real harnesses (verified live against both claude-agent-acp and codex) advertise their
      // modes and config options here — the product's model/effort choice is exactly these. A
      // double that omitted them let the product side "pass" against a shape the real Agent never
      // sends, so it carries them too, with the same ids the real ones use.
      return { sessionId, modes: config.modes(), configOptions: config.options() }
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
      const { sessionId, configId, value } = context.params as unknown as { sessionId: string; configId: string; value: string }
      if (!stateCell.current || stateCell.current.acpSessionId !== sessionId) throw acp.RequestError.resourceNotFound(sessionId)
      const option = FAKE_CONFIG_OPTIONS.find((o) => o.id === configId)
      // The Agent is authoritative on what exists — an unknown option or value is refused, so the
      // product surface's own error path is exercised against a real refusal rather than a mock.
      if (!option) throw acp.RequestError.invalidParams(`unknown config option '${configId}'`)
      if (!option.options.some((o) => o.value === value)) throw acp.RequestError.invalidParams(`invalid value '${value}' for '${configId}'`)
      config.setOption(configId, value)
      // The full set comes back, because changing one option may change the others (real behaviour).
      return { configOptions: config.options() }
    })
    .onRequest(acp.methods.agent.session.setMode, async (context) => {
      const { sessionId, modeId } = context.params as { sessionId: string; modeId: string }
      if (!stateCell.current || stateCell.current.acpSessionId !== sessionId) throw acp.RequestError.resourceNotFound(sessionId)
      if (!FAKE_MODES.some((m) => m.id === modeId)) throw acp.RequestError.invalidParams(`unknown mode '${modeId}'`)
      config.setMode(modeId)
      // ACP's set_mode returns nothing (unlike set_config_option, which returns the full option
      // set) — the new mode is observable via session/update, not the response.
      return {}
    })
    .onRequest(acp.methods.agent.session.resume, async (context) => {
      const { sessionId } = context.params
      if (!stateCell.current || stateCell.current.acpSessionId !== sessionId) {
        throw acp.RequestError.resourceNotFound(sessionId)
      }
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      if (options.onPrompt) return options.onPrompt(context.params, context)
      const text = context.params.prompt.map((block) => ('text' in block ? block.text : '')).join('')
      if (stateCell.current && stateCell.current.acpSessionId === context.params.sessionId) {
        stateCell.current = {
          acpSessionId: stateCell.current.acpSessionId,
          promptsSeen: stateCell.current.promptsSeen + 1,
          lastMessages: [...stateCell.current.lastMessages, text].slice(-MAX_REMEMBERED_MESSAGES),
        }
      }
      const count = stateCell.current?.promptsSeen ?? 1
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `hello from the fake Agent (prompt #${count})` },
        },
      })
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, async (context) => {
      if (options.onCancel) await options.onCancel(context.params, context)
    })
}

/** Mirrors the shape both real harnesses advertise (ids verified live: `model` and `effort` on claude-agent-acp). */
const FAKE_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    type: 'select' as const,
    category: 'model',
    options: [
      { name: 'Default (recommended)', value: 'default' },
      { name: 'Sonnet', value: 'sonnet' },
      { name: 'Opus', value: 'opus' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    type: 'select' as const,
    category: 'thought_level',
    // The OLD system's effort rail, same levels.
    options: [
      { name: 'Low', value: 'low' },
      { name: 'Medium', value: 'medium' },
      { name: 'High', value: 'high' },
      { name: 'Xhigh', value: 'xhigh' },
      { name: 'Max', value: 'max' },
    ],
  },
]

const FAKE_MODES = [
  { id: 'default', name: 'Manual', description: 'Standard behavior' },
  { id: 'plan', name: 'Plan Mode', description: 'Planning mode, no actual tool execution' },
]


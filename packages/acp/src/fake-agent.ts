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

export function createFakeAgent(options: FakeAgentOptions = {}): acp.AgentApp {
  const stateCell = options.nativeState ?? { current: undefined }

  return acp
    .agent({ name: 'agora-fake-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: options.agentCapabilities ?? { loadSession: false, sessionCapabilities: { resume: {} } },
    }))
    .onRequest(acp.methods.agent.session.new, async (context) => {
      if (options.onSessionNew) return options.onSessionNew(context.params, context)
      const sessionId = options.acpSessionId ?? 'fake-acp-session'
      stateCell.current = { acpSessionId: sessionId, promptsSeen: 0, lastMessages: [] }
      return { sessionId }
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

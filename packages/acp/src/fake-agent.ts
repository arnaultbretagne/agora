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
}

export function createFakeAgent(options: FakeAgentOptions = {}): acp.AgentApp {
  return acp
    .agent({ name: 'agora-fake-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: options.agentCapabilities ?? { loadSession: false },
    }))
    .onRequest(acp.methods.agent.session.new, async (context) => {
      if (options.onSessionNew) return options.onSessionNew(context.params, context)
      return { sessionId: options.acpSessionId ?? 'fake-acp-session' }
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      if (options.onPrompt) return options.onPrompt(context.params, context)
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello from the fake Agent' },
        },
      })
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, async (context) => {
      if (options.onCancel) await options.onCancel(context.params, context)
    })
}

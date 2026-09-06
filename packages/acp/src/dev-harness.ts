// Local development harness (S4): an in-process fake ACP Agent on the pinned SDK, wired to an
// in-memory duplex pair, so tests and local development exercise capture → persist → project
// without Kubernetes, a bridge or provider credentials. Behaviors are deliberately canned:
// initialize → session/new → session/prompt (message chunks, one permission request, a stop).
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from './framing.js'

export interface FakeAgentOptions {
  /** Called with the prompt text once the agent sees the prompt request. */
  readonly onPrompt?: (text: string) => void
  readonly replyText?: string
  readonly withPermissionRequest?: boolean
  /** Delays the reply so interleavings (a second prompt mid-turn) are observable in tests. */
  readonly promptDelayMs?: number | undefined
}

export interface DevHarness {
  /** Client side — feed into the capture seam via buildClientConnection. */
  readonly clientStream: DuplexByteStream
  /** The agent-side connection, for assertions and direct notifications from tests. */
  readonly agentConnection: acp.AgentConnection
  /** Notifies every connected client; used to inject synthetic or late frames. */
  readonly notifyUpdate: (sessionId: string, update: Record<string, unknown>) => Promise<void>
  /** Sends an extension (vendor) notification — accepted at capture as an extension method. */
  readonly notifyExtension: (method: string, params: Record<string, unknown>) => Promise<void>
  readonly close: () => void
}

export function startFakeAgent(options: FakeAgentOptions = {}): DevHarness {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()
  const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
  const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }

  const agentApp = acp.agent({ name: 'agora-fake-agent' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  agentApp.onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'acp-dev-session' }))
  agentApp.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const prompt = params as { sessionId: string; prompt?: Array<{ type: string; text?: string }> }
    options.onPrompt?.((prompt.prompt ?? []).map((block) => block.text ?? '').join(''))
    if (options.promptDelayMs !== undefined && options.promptDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.promptDelayMs))
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: prompt.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: options.replyText ?? 'hello from the fake agent' },
      },
    })
    if (options.withPermissionRequest !== false) {
      await client.request(acp.methods.client.session.requestPermission, {
        sessionId: prompt.sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Read a file', kind: 'read', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      })
    }
    return { stopReason: 'end_turn' }
  })

  const agentStreamNdJson = acp.ndJsonStream(agentStream.writable, agentStream.readable)
  const agentConnection = agentApp.connect(agentStreamNdJson)

  return {
    clientStream,
    agentConnection,
    notifyUpdate: async (sessionId: string, update: Record<string, unknown>) => {
      await agentConnection.client.notify(acp.methods.client.session.update, { sessionId, update })
    },
    notifyExtension: async (method: string, params: Record<string, unknown>) => {
      await agentConnection.client.notify(method, params)
    },
    close: () => {
      agentConnection.close?.()
    },
  }
}

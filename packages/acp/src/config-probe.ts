import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from './journaling-stream.js'

export interface ProbeAgentConfigurationInput {
  readonly stream: DuplexByteStream
  readonly cwd: string
  readonly clientCapabilities?: acp.ClientCapabilities
}

export interface ProbedAgentConfiguration {
  readonly acpSessionId: string
  readonly protocolVersion: number
  readonly configOptions: readonly acp.SessionConfigOption[]
  readonly modes?: acp.SessionModeState
}

/**
 * The "empty run": `initialize` + `session/new` against a real Agent purely to read what it says it
 * can be configured with, then nothing else.
 *
 * Why it exists: an ACP Agent advertises its config options in the `session/new` response and
 * nowhere else — there is no catalogue request, and `session/new` is the only place the answer
 * appears. So an Agent nobody has ever launched cannot be asked what models it offers without
 * launching it once. The operator chose this over declaring a model list in the product (P12), which
 * would go stale the moment a harness ships a new model.
 *
 * Deliberately NOT journaled and NOT bound to a Session: no `journalDuplexStream`, no pool, no
 * `product.sessions` row. This is a question about an Agent, not a conversation — a probe's frames
 * are not part of any Workstream's history, and inventing a Session to hold them would put a
 * conversation nobody started in the operator's sidebar. The caller owns the Runtime this stream
 * belongs to and is responsible for tearing it down (`apps/web/src/config-catalogue.ts`).
 *
 * `session/prompt` is never sent, so no provider call is made and no model is charged for.
 */
export async function probeAgentConfiguration(input: ProbeAgentConfigurationInput): Promise<ProbedAgentConfiguration> {
  const wire = acp.ndJsonStream(input.stream.writable, input.stream.readable)
  const connection = acp
    .client({ name: 'agora-config-probe' })
    // A probe answers nothing: it sends two requests and reads two responses. The notification sink
    // exists because an Agent may legitimately start narrating before it is asked anything, and an
    // unhandled notification would surface as a protocol error rather than the silence it is.
    .onNotification(acp.methods.client.session.update, () => {})
    .connect(wire)

  const initializeResponse = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: input.clientCapabilities ?? { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })

  const newSessionResponse = await connection.agent.request(acp.methods.agent.session.new, { cwd: input.cwd, mcpServers: [] })

  return {
    acpSessionId: newSessionResponse.sessionId,
    protocolVersion: initializeResponse.protocolVersion,
    configOptions: newSessionResponse.configOptions ?? [],
    ...(newSessionResponse.modes ? { modes: newSessionResponse.modes } : {}),
  }
}

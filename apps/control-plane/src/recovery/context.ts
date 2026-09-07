// Prompt delivery recovery (S8 Step 5 — engine.md "Prompt delivery and context creation",
// CONT-005). Completes S4's `unknown` handling: reconnect to the same verified Pod/process/context,
// seek operation-specific evidence, and resolve the ambiguous dispatch ONLY when the evidence
// actually proves it either way — otherwise it stays `unknown`, visible, and the next turn stays
// gated. Nothing here re-sends anything: the caller decides what to do once a verdict exists.
//
// The evidence is `session/load`, measured live against the pinned adapter on 2026-09-06 (recorded
// in harnesses/claude-code/README.md, "Step 5 measurement"): loading a context replays its whole
// history as `session/update` notifications — `user_message_chunk` for each prompt the harness
// actually received, `agent_message_chunk` for each reply — carrying the verbatim text. Our own
// side owns the complete send history for this context (command_dispatches), so comparing the two
// in order is a real proof, not a heuristic: the Nth prompt we attempted must appear as the Nth
// user message in the replay.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { within } from '../deadline.js'
import {
  attemptedPrompts,
  buildClientConnection,
  connectBridge,
  createPersist,
  initializeParams,
  resolveUnknownAsDelivered,
  resolveUnknownAsNeverDelivered,
  type BridgeConnection,
} from '@agora/acp'
import { currentSession } from '@agora/journal'
import { workspaceRoot } from '../workspace-root.js'

export interface PromptRecoveryOptions {
  readonly productPool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly bridgePort: number
  /** Deadline for the bridge connect and this control call (P7 — harness.adapterRequestTimeoutMs). A PROMPT is never bounded this way: a model answering for minutes is working, not hung. */
  readonly requestTimeoutMs?: number
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket. */
  readonly connect?: (options: { readonly url: string; readonly token: string }) => Promise<BridgeConnection>
}

export type PromptRecoveryVerdict =
  /** The replay proved the harness never received it — `rejected_before_acceptance`, safe to retry. */
  | { readonly kind: 'never_delivered'; readonly commandId: string }
  /** The replay showed it; `answered` says whether a reply followed. Settled as `responded`. */
  | { readonly kind: 'delivered'; readonly commandId: string; readonly answered: boolean }
  /** Nothing proved either way — the dispatch stays `unknown` and the next turn stays gated. */
  | { readonly kind: 'unresolved'; readonly reason: string }
  /** There was no ambiguous prompt to resolve in the first place. */
  | { readonly kind: 'nothing_to_recover' }

interface PodInventoryEntry {
  readonly name: string
  readonly forcedDeletion: boolean
  readonly podIP: string | null
}

interface ReplayedMessage {
  readonly role: 'user' | 'agent'
  readonly text: string
}

/**
 * Resolves this Workstream's one ambiguous prompt, if it has one. Never throws for an
 * infrastructure reason — an unreachable Pod or a moved process generation is `unresolved`, which
 * is the honest answer, not a failure the caller has to special-case.
 */
export async function recoverPromptDelivery(options: PromptRecoveryOptions, workstreamId: string): Promise<PromptRecoveryVerdict> {
  try {
    return await recover(options, workstreamId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    options.logger?.(`prompt recovery for ${workstreamId} could not complete: ${reason}`)
    return { kind: 'unresolved', reason }
  }
}

async function recover(options: PromptRecoveryOptions, workstreamId: string): Promise<PromptRecoveryVerdict> {
  const session = await currentSession(options.productPool, workstreamId)
  if (session === null) return { kind: 'unresolved', reason: 'no current Session' }

  const attempted = await attemptedPrompts(options.productPool, workstreamId, session.sessionId)
  const ambiguousIndex = attempted.findIndex((prompt) => prompt.state === 'unknown')
  if (ambiguousIndex === -1) return { kind: 'nothing_to_recover' }
  const ambiguous = attempted[ambiguousIndex]!
  if (ambiguous.text === null) {
    return { kind: 'unresolved', reason: `command ${ambiguous.id} has no recorded prompt text to compare against` }
  }

  if (session.acpContextId === null || session.bridgeToken === null) {
    // Nothing was ever bound, so nothing could have been sent through a context — but this is still
    // not proof about THIS command (the binding could have been lost separately); stay honest.
    return { kind: 'unresolved', reason: 'the Session has no bound ACP context to read evidence from' }
  }

  const pod = await findEstablishedPod(options.runtimeControlBaseUrl, workstreamId)
  if (pod === undefined || pod.podIP === null) return { kind: 'unresolved', reason: 'no established Pod with a reachable address' }

  const currentGeneration = await fetchProcessGeneration(options.runtimeControlBaseUrl, pod.name)
  if (currentGeneration === undefined) return { kind: 'unresolved', reason: 'runtime-control evidence is unreachable' }
  if (currentGeneration !== session.processGeneration) {
    // Measured: the adapter's transcript survives a process restart on the same filesystem, so a
    // replay would still be READABLE here. It is deliberately not read: SESSION-A06 retires the
    // incarnation on a generation change, and proving delivery across that boundary is S9's custody
    // work, not something to infer from a context this Session no longer owns.
    return { kind: 'unresolved', reason: 'the bound context is not the current process generation (SESSION-A06 retires it; S9 custody owns cross-generation proof)' }
  }

  const replay = await loadReplay(options, { workstreamId, session, podIP: pod.podIP, contextId: session.acpContextId })
  const userMessages = replay.filter((message) => message.role === 'user')

  if (userMessages.length <= ambiguousIndex) {
    // The harness's own history has fewer prompts than we attempted up to this one: it never got it.
    return await settle(options, 'never_delivered', ambiguous.id)
  }
  const matching = userMessages[ambiguousIndex]!
  if (matching.text !== ambiguous.text) {
    return {
      kind: 'unresolved',
      reason: `replay position ${ambiguousIndex} does not match the dispatched text — the histories disagree, which is never resolved by guessing`,
    }
  }

  // Delivered. Answered iff the harness produced an agent message after this user message.
  const positionInReplay = indexOfNthUserMessage(replay, ambiguousIndex)
  const answered = replay.slice(positionInReplay + 1).some((message) => message.role === 'agent')
  return await settle(options, 'delivered', ambiguous.id, answered)
}

function indexOfNthUserMessage(replay: readonly ReplayedMessage[], n: number): number {
  let seen = 0
  for (let index = 0; index < replay.length; index += 1) {
    if (replay[index]!.role === 'user') {
      if (seen === n) return index
      seen += 1
    }
  }
  return replay.length
}

async function settle(
  options: PromptRecoveryOptions,
  kind: 'never_delivered' | 'delivered',
  commandId: string,
  answered = false,
): Promise<PromptRecoveryVerdict> {
  const client = await options.productPool.connect()
  try {
    await client.query('SET ROLE agora_product')
    await client.query('BEGIN')
    if (kind === 'delivered') await resolveUnknownAsDelivered(client, commandId)
    else await resolveUnknownAsNeverDelivered(client, commandId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.query('RESET ROLE').catch(() => {})
    client.release()
  }
  options.logger?.(`prompt recovery settled ${commandId} as ${kind}${kind === 'delivered' ? ` (answered=${String(answered)})` : ''}`)
  return kind === 'delivered' ? { kind: 'delivered', commandId, answered } : { kind: 'never_delivered', commandId }
}

/** Connects, loads the bound context, and collects the replayed messages in order. Every frame is captured through the same persist seam as any other ACP traffic (execution.md). */
async function loadReplay(
  options: PromptRecoveryOptions,
  input: { workstreamId: string; session: { sessionId: string; bridgeToken: string | null }; podIP: string; contextId: string },
): Promise<readonly ReplayedMessage[]> {
  const connect = options.connect ?? connectBridge
  const bridge = await connect({ url: `ws://${input.podIP}:${options.bridgePort}/`, token: input.session.bridgeToken! })
  const replay: ReplayedMessage[] = []
  try {
    const client = await options.productPool.connect()
    try {
      await client.query('SET ROLE agora_product')
      const persist = createPersist(client, {
        workstreamId: input.workstreamId,
        sessionId: input.session.sessionId,
        connectionId: randomUUID(),
        commandIdFor: () => null,
      })
      const connection = buildClientConnection(bridge.stream, persist, {
        onSessionUpdate: (params) => {
          const message = toReplayedMessage(params)
          if (message !== null) replay.push(message)
        },
      })
      try {
        // `initialize` is deliberately NOT sent here. It is a PROCESS-level handshake the harness bridge
        // performs once when it spawns the adapter (packages/harness-bridge/src/handshake.ts): codex-acp
        // answers a second one with "Already initialized", and both pinned adapters accept `session/*` on a
        // connection that never initialized — so re-initializing per verb bought nothing and broke one of
        // the two harnesses.
        await within(
          connection.agent.request(acp.methods.agent.session.load, { sessionId: input.contextId, cwd: workspaceRoot(), mcpServers: [] }),
          options.requestTimeoutMs,
          'session/load',
        )
      } finally {
        connection.close()
      }
    } finally {
      await client.query('RESET ROLE').catch(() => {})
      client.release()
    }
  } finally {
    await bridge.close()
  }
  return replay
}

/** Measured shape (2026-09-06): `{sessionId, update: {sessionUpdate, content: {type:'text', text}, messageId}}`. */
function toReplayedMessage(params: unknown): ReplayedMessage | null {
  const update = (params as { update?: { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } } } | null)?.update
  if (update === undefined) return null
  const text = update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : null
  if (text === null) return null
  if (update.sessionUpdate === 'user_message_chunk') return { role: 'user', text }
  if (update.sessionUpdate === 'agent_message_chunk') return { role: 'agent', text }
  return null
}

async function findEstablishedPod(runtimeControlBaseUrl: string, workstreamId: string): Promise<PodInventoryEntry | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
  if (!res.ok) return undefined
  const inventory = (await res.json()) as { pods: readonly PodInventoryEntry[] }
  return inventory.pods.find((pod) => !pod.forcedDeletion)
}

async function fetchProcessGeneration(runtimeControlBaseUrl: string, podName: string): Promise<number | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/pods/${podName}/evidence`)
  if (!res.ok) return undefined
  const evidence = (await res.json()) as { processGeneration?: number }
  return typeof evidence.processGeneration === 'number' ? evidence.processGeneration : undefined
}

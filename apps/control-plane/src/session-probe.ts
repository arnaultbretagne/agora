// Live session probe (S8 Step 2 — execution.md "ACP facts and current evidence"): "current
// configuration comes from a fresh owner snapshot or a freshly verified, complete ordered stream
// continuing from such a snapshot for the same process/context" — P3 found no config_option_update
// stream follows set_config_option for this adapter, so a fresh snapshot is the only freshness
// proof available, taken the same connect-act-disconnect way START itself binds a context
// (bridge-server.ts's adapter process outlives any one WebSocket). Every ACP frame is captured
// before anything else touches it (execution.md) — even a probe's, through the same persist seam
// START and, later, prompt dispatch use.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, connectBridge, createPersist, initializeParams, type BridgeConnection } from '@agora/acp'
import { workspaceRoot } from './workspace-root.js'

export interface SessionProbeOptions {
  readonly productPool: pg.Pool
  readonly bridgePort: number
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket. */
  readonly connect?: (options: { readonly url: string; readonly token: string }) => Promise<BridgeConnection>
  /**
   * How long the connect and the one ACP request may take (P7 — harness.adapterRequestTimeoutMs).
   *
   * An adapter that accepts the WebSocket and then answers nothing is indistinguishable from a slow
   * one, and this probe runs INSIDE a reconciliation tick that holds the Workstream's claim: without
   * a deadline, one unresponsive Pod stops that Workstream reconciling for ever. A probe that times
   * out reports `disconnected`, which is what "we could not read it" has always meant here.
   */
  readonly requestTimeoutMs?: number
}

/** Rejects if the promise has not settled inside the deadline. The probe's catch turns that into `disconnected`. */
async function within<T>(work: Promise<T>, timeoutMs: number | undefined, what: string): Promise<T> {
  if (timeoutMs === undefined) return work
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${String(timeoutMs)}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface SessionProbeResult {
  readonly connected: boolean
  /** configId -> currentValue, straight off the resume response (S8 Step 3 reads this for model/effort; unused by session() itself). */
  readonly configOptions: ReadonlyMap<string, string>
}

const DISCONNECTED: SessionProbeResult = { connected: false, configOptions: new Map() }

/**
 * Resumes the workstream's bound ACP context to prove it is actually still live, right now — never
 * a cached record. Any failure (unreachable Pod, dead process, adapter rejects the resume) reports
 * `connected: false`; it is never thrown, this is an evidence read like any other in 002 Observation.
 */
export async function probeSession(
  input: {
    readonly workstreamId: string
    /** The Agora Session's own id (sessions.id) — what captured frames are attributed to, never the ACP context id. */
    readonly sessionId: string
    readonly podIP: string | null
    readonly bridgeToken: string
    readonly contextId: string
    /** How this harness's current configuration can be read back (S10 Step 1). Defaults to `resume`. */
    readonly configReadback?: 'resume' | 'set-config-noop'
    /** For `set-config-noop`: the model the Intent already wants, and this harness's own option id for it. */
    readonly desiredModel?: string
    readonly modelOptionId?: string
  },
  options: SessionProbeOptions,
): Promise<SessionProbeResult> {
  if (input.podIP === null) return DISCONNECTED
  const connect = options.connect ?? connectBridge
  try {
    const connection = await within(connect({ url: `ws://${input.podIP}:${options.bridgePort}/`, token: input.bridgeToken }), options.requestTimeoutMs, 'the bridge')
    try {
      const client = await options.productPool.connect()
      try {
        await client.query('SET ROLE agora_product')
        const persist = createPersist(client, {
          workstreamId: input.workstreamId,
          sessionId: input.sessionId,
          connectionId: randomUUID(),
          commandIdFor: () => null,
        })
        const clientConnection = buildClientConnection(connection.stream, persist)
        try {
          // `initialize` is deliberately NOT sent here. It is a PROCESS-level handshake the harness bridge
          // performs once when it spawns the adapter (packages/harness-bridge/src/handshake.ts): codex-acp
          // answers a second one with "Already initialized", and both pinned adapters accept `session/*` on a
          // connection that never initialized — so re-initializing per verb bought nothing and broke one of
          // the two harnesses.
          // How the current config is read back depends on the harness, and the second one is why
          // (S10 Step 1). `session/resume` is the natural read — it returns every option's current
          // value — but codex does not persist a context until it has content, so resuming one that
          // has never been prompted fails with "no rollout found for thread id". Its own
          // `set_session_config` answers for that same context, and returns the same option list, so
          // for codex the read is an assertion of the value CONFIG wants anyway: idempotent when it
          // already matches, and exactly the mutation CONFIG would perform when it does not.
          const readback =
            input.configReadback === 'set-config-noop' && input.desiredModel !== undefined
              ? ((await within(
                  clientConnection.agent.request(acp.methods.agent.session.setConfigOption, {
                    sessionId: input.contextId,
                    configId: input.modelOptionId ?? 'model',
                    value: input.desiredModel,
                  }),
                  options.requestTimeoutMs,
                  'set_session_config',
                )) as { configOptions?: readonly { id?: unknown; currentValue?: unknown }[] })
              : ((await within(
                  clientConnection.agent.request(acp.methods.agent.session.resume, {
                    sessionId: input.contextId,
                    cwd: workspaceRoot(),
                    mcpServers: [],
                  }),
                  options.requestTimeoutMs,
                  'session/resume',
                )) as { configOptions?: readonly { id?: unknown; currentValue?: unknown }[] })
          const resumed = readback
          const configOptions = new Map<string, string>()
          for (const option of resumed.configOptions ?? []) {
            if (typeof option.id === 'string' && typeof option.currentValue === 'string') configOptions.set(option.id, option.currentValue)
          }
          return { connected: true, configOptions }
        } finally {
          clientConnection.close()
        }
      } finally {
        await client.query('RESET ROLE').catch(() => {})
        client.release()
      }
    } finally {
      // Bounded, like everything else here: a close that never resolves is a tick that never ends,
      // and this one runs in a `finally`, so it would swallow the result we already have.
      await within(Promise.resolve(connection.close()), options.requestTimeoutMs, 'the bridge close').catch(() => {})
    }
  } catch (error) {
    options.logger?.(`session probe for ${input.workstreamId} failed: ${error instanceof Error ? error.message : String(error)}`)
    return DISCONNECTED
  }
}

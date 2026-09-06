// RESTORE (S9 Step 4 — 003 verbs, continuity.md, CONT-003/007/008). Selects the Anchor's Save,
// has runtime-control place it in the Pod, resumes the native context and binds it to the NEW
// Agora Session with origin watermark W. It delivers no Handoff: refilling `(W, H]` is REFILL's
// job, and doing both here would make a resume that lost its refill look like a resume that never
// needed one.
//
// The Session it binds to is always new (CONT-003). A restore is not a continuation of the Session
// that produced the Save — that Session's attribution ended with its Pod. Reusing the same ACP
// context id across the two is fine and expected: the id is the harness's, not an Agora identity.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, connectBridge, createPersist, initializeParams, type BridgeConnection } from '@agora/acp'
import { bindAcpContext, currentSession, recordRestoreOrigin } from '@agora/journal'
import { getAnchor, getSave, invalidate, isExcluded, type Save } from '@agora/custody'
import { normalizeAnchor } from '@agora/observation'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import { WORKSPACE_ROOT } from '../workspace-root.js'

export interface RestoreHarness {
  readonly harnessId: string
  readonly supportedFormats: readonly { readonly formatId: string; readonly formatVersion: number }[]
  readonly acceptedDriverRevisions: readonly string[]
  readonly workspaceDeps?: Readonly<Record<string, string>>
}

export interface RestoreExecutorOptions {
  readonly productPool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly bridgePort: number
  /** The deployed harness definition a Save must be compatible with. */
  readonly harness: RestoreHarness
  /** How long to wait for the Pod to place and verify the transcript before giving up for this tick. */
  readonly placementTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket. */
  readonly connect?: (options: { readonly url: string; readonly token: string }) => Promise<BridgeConnection>
}

interface PodInventoryEntry {
  readonly name: string
  readonly forcedDeletion: boolean
  readonly incarnation: string | null
  readonly podIP: string | null
}

export class UnsupportedVerbError extends Error {
  constructor(readonly verb: Verb) {
    super(`the RESTORE executor does not handle ${verb}`)
    this.name = 'UnsupportedVerbError'
  }
}

export function createRestoreExecutor(options: RestoreExecutorOptions): VerbExecutor {
  const connect = options.connect ?? connectBridge
  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      if (verb !== 'RESTORE') throw new UnsupportedVerbError(verb)
      try {
        await runRestore(options, connect, context)
      } catch (error) {
        // Same shape as START: a failed restore is retried on the next tick with fresh evidence,
        // never surfaced as a verb failure the engine has to interpret. Crucially, a failure here
        // invalidates NOTHING — only a verified incompatibility does that, and that decision is
        // taken explicitly below (CONT-008).
        options.logger?.(`RESTORE for ${context.workstreamId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

async function runRestore(
  options: RestoreExecutorOptions,
  connect: NonNullable<RestoreExecutorOptions['connect']>,
  context: VerbContext,
): Promise<void> {
  const session = await currentSession(options.productPool, context.workstreamId)
  if (session === null || session.bridgeToken === null) return // birth/gate not caught up yet
  if (session.acpContextId !== null) return // this Session already holds a context; RESTORE is done

  const anchor = await getAnchor(options.productPool, context.workstreamId, options.harness.harnessId)
  if (anchor === null) return // nothing to restore — the rule tables will select START instead
  const save = await getSave(options.productPool, anchor.saveId)
  if (save === null) return

  const excluded = await isExcluded(options.productPool, save.id, save.driverRevision)
  const compatibility = normalizeAnchor({
    save,
    harness: options.harness,
    invalidated: excluded,
  })
  if (compatibility === 'none') {
    // Permanent and VERIFIED: this Save cannot be read by this harness, and no retry changes that.
    // Recording it is what stops the next tick looping on the known-bad Save (CONT-008); cleanup
    // then proceeds through the ordinary path, with no restore-to-start switch inside this Session.
    if (!excluded) await recordVerifiedIncompatibility(options, save)
    return
  }

  const pod = await findEstablishedPod(options.runtimeControlBaseUrl, context.workstreamId)
  if (pod === undefined || pod.podIP === null || pod.incarnation === null) return

  const placed = await placeSaveInPod(options, pod.name, save)
  if (!placed) return // the transcript is not verifiably in place; resuming now would prove nothing

  const currentGeneration = await fetchProcessGeneration(options.runtimeControlBaseUrl, pod.name)
  if (currentGeneration === undefined) return // evidence unreachable — never guess a generation

  const connection = await connect({ url: `ws://${pod.podIP}:${options.bridgePort}/`, token: session.bridgeToken })
  try {
    const client = await options.productPool.connect()
    try {
      await client.query('SET ROLE agora_product')
      const persist = createPersist(client, {
        workstreamId: context.workstreamId,
        sessionId: session.sessionId,
        connectionId: randomUUID(),
        commandIdFor: () => null,
      })
      const clientConnection = buildClientConnection(connection.stream, persist)
      try {
        await clientConnection.agent.request(acp.methods.agent.initialize, initializeParams(WORKSPACE_ROOT))
        // The context id is the Save's own — the transcript that was just placed IS that context.
        await clientConnection.agent.request(acp.methods.agent.session.resume, { sessionId: save.contextId, cwd: WORKSPACE_ROOT, mcpServers: [] })
        await bindAcpContext(client, session.sessionId, { contextId: save.contextId, processGeneration: currentGeneration })
        // The opening range's lower bound: what this Save could PROVE the context had (CONT-009).
        // REFILL's range starts here, so recording anything more optimistic would silently skip
        // facts the context never saw.
        await recordRestoreOrigin(client, session.sessionId, { originW: save.frontierW, saveId: save.id })
        options.logger?.(`restored Save ${save.id} into Session ${session.sessionId} at W=${String(save.frontierW)}`)
      } finally {
        clientConnection.close()
      }
    } finally {
      await client.query('RESET ROLE').catch(() => {})
      client.release()
    }
  } finally {
    await connection.close()
  }
}

/**
 * Asks runtime-control to offer the Save to the Pod, then waits for the Pod's own driver to report
 * a placement that matches the Save's checksum. Returning false is not a failure to record — it is
 * "not yet", and the next tick asks again against the same staged placement.
 */
async function placeSaveInPod(options: RestoreExecutorOptions, podName: string, save: Save): Promise<boolean> {
  const base = `${options.runtimeControlBaseUrl}/v1/pods/${podName}/custody`
  const staged = await fetch(`${base}/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ saveId: save.id, checksum: save.checksum, byteLength: save.byteLength }),
  })
  if (!staged.ok && staged.status !== 409) return false

  const deadline = Date.now() + (options.placementTimeoutMs ?? 30_000)
  for (;;) {
    const status = await fetch(`${base}/placement-status`)
    if (status.ok) {
      const body = (await status.json()) as { status?: string }
      if (body.status === 'placed') return true
      if (body.status === 'rejected') {
        // The bytes that landed are not the Save's. That is not an incompatibility — the Save is
        // fine and some other attempt may place it correctly — so nothing is invalidated here.
        options.logger?.(`the placement of Save ${save.id} in ${podName} was rejected; not resuming`)
        return false
      }
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 500))
  }
}

async function recordVerifiedIncompatibility(options: RestoreExecutorOptions, save: Save): Promise<void> {
  const client = await options.productPool.connect()
  try {
    await invalidate(client, {
      saveId: save.id,
      // Scoped to the driver revision, not the Save: a corrected driver can still read these bytes,
      // and excluding the Save outright would throw away recoverable state (CONT-008).
      driverRevision: save.driverRevision,
      cause: `the deployed ${options.harness.harnessId} harness cannot read format ${save.formatId} v${String(save.formatVersion)} under driver ${save.driverRevision}`,
      verifier: 'control-plane/restore',
      target: options.harness.acceptedDriverRevisions.join(',') || options.harness.harnessId,
    })
  } finally {
    client.release()
  }
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

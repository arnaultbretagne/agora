// A conformance target is a harness under test reached through its own ACP surface — never by
// importing it (ADR 0001 forbids a deployable depending on another, and a black-box suite is what
// "runnable against any harness image" means anyway). Two shapes cover both uses: a locally
// spawned adapter/bridge entry point (what CI and a developer laptop can run), and a live Pod's
// bridge WebSocket (what the end-to-end run on Kubernetes uses). Both hand back the same
// DuplexByteStream packages/acp's client already speaks.
import { spawn } from 'node:child_process'
import { connectBridge, type DuplexByteStream } from '@agora/acp'

export interface TargetConnection {
  readonly stream: DuplexByteStream
  readonly close: () => Promise<void>
}

export interface ConformanceTarget {
  /** For the report — which harness this was run against. */
  readonly harnessId: string
  /** What the reviewed catalogue says this harness must be; identity checks compare against it. */
  readonly expected: {
    readonly adapterName?: string
    readonly adapterVersion?: string
    readonly protocolVersion?: number
  }
  /** The fixed workspace root the harness is launched with. */
  readonly workspaceRoot: string
  /**
   * What this harness calls the two options the Intent names `model` and `effort` (S10 Step 1).
   * codex calls effort `reasoning_effort`; looking for `effort` there would report a missing option
   * where the only thing missing was the mapping.
   */
  readonly configOptionIds?: { readonly model: string; readonly effort: string }
  /** Opening a second connection must reach the SAME harness process (bridge-server.ts's contract). */
  connect(): Promise<TargetConnection>
  /** Explicitly opted into by the operator: checks that would spend real model usage stay skipped otherwise. */
  readonly allowModelSpend?: boolean
  /** Set when the target is reached through the Broker relay, enabling the isolation checks. */
  readonly relay?: { readonly allowedHost: string; readonly deniedHost: string }
}

export interface SpawnedAdapterOptions {
  readonly configOptionIds?: ConformanceTarget['configOptionIds']
  readonly harnessId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly workspaceRoot: string
  readonly expected?: ConformanceTarget['expected']
  readonly allowModelSpend?: boolean
}

/**
 * Spawns the harness's own adapter entry point once and lets every connection attach to that same
 * process — the same shape the real bridge server guarantees ("the adapter process is spawned
 * exactly once and OUTLIVES any single WebSocket connection"), so a suite result here means the
 * same thing it would mean through a Pod.
 */
export function spawnedAdapterTarget(options: SpawnedAdapterOptions): ConformanceTarget & { readonly shutdown: () => void } {
  const child = spawn(options.command, [...options.args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  })

  // Each connection gets its OWN stream pair over the one shared process, and detaching removes
  // only that connection's listener — precisely what the real bridge server does
  // ("socket.on('close', () => adapter.stdout.off('data', onAdapterData))"). Sharing a single
  // web-stream pair across connections instead would lock on the second connect, which is not a
  // property of the harness at all, just of the emulation.
  const connect = async (): Promise<TargetConnection> => {
    let onData: ((chunk: Buffer) => void) | undefined
    let closed = false
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        onData = (chunk: Buffer) => {
          if (!closed) controller.enqueue(new Uint8Array(chunk))
        }
        child.stdout.on('data', onData)
      },
      cancel() {
        closed = true
        if (onData !== undefined) child.stdout.off('data', onData)
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) => {
          child.stdin.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()))
        })
      },
    })
    return {
      stream: { readable, writable },
      // Detaches this connection only; the harness process is deliberately untouched, so a later
      // connect() reaches the same still-running process with the same live contexts.
      close: async () => {
        closed = true
        if (onData !== undefined) child.stdout.off('data', onData)
      },
    }
  }

  return {
    harnessId: options.harnessId,
    expected: options.expected ?? {},
    workspaceRoot: options.workspaceRoot,
    ...(options.allowModelSpend === undefined ? {} : { allowModelSpend: options.allowModelSpend }),
    ...(options.configOptionIds === undefined ? {} : { configOptionIds: options.configOptionIds }),
    connect,
    shutdown: () => child.kill(),
  }
}

export interface BridgeTargetOptions {
  readonly configOptionIds?: ConformanceTarget['configOptionIds']
  readonly harnessId: string
  readonly url: string
  readonly token: string
  readonly workspaceRoot: string
  readonly expected?: ConformanceTarget['expected']
  readonly allowModelSpend?: boolean
  readonly relay?: ConformanceTarget['relay']
}

/** A live Pod's bridge — the same P4-authenticated WebSocket the control plane itself uses. */
export function bridgeTarget(options: BridgeTargetOptions): ConformanceTarget {
  return {
    harnessId: options.harnessId,
    expected: options.expected ?? {},
    workspaceRoot: options.workspaceRoot,
    ...(options.allowModelSpend === undefined ? {} : { allowModelSpend: options.allowModelSpend }),
    ...(options.relay === undefined ? {} : { relay: options.relay }),
    ...(options.configOptionIds === undefined ? {} : { configOptionIds: options.configOptionIds }),
    connect: async () => {
      const bridge = await connectBridge({ url: options.url, token: options.token })
      return { stream: bridge.stream, close: () => bridge.close() }
    },
  }
}

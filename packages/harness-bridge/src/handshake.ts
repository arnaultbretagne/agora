// The adapter's own `initialize` handshake (S10 Step 1).
//
// `initialize` is a PROCESS-level handshake, not a per-connection one, and the second harness is
// what proved it: `codex-acp` 1.10.0 answers a second `initialize` on the same process with
// `Internal error {"details":"Already initialized"}`, while `claude-agent-acp` 0.75.1 tolerates
// repeats. Both accept `session/new` on a connection that never initialized at all.
//
// Agora used to initialize on every verb execution, because connect-act-disconnect opens a fresh
// connection each time. Against codex that would fail every verb after the first. The fix belongs
// here rather than in the control plane: whoever owns the process owns its handshake, and the bridge
// is the only thing that spawns the adapter exactly once.
import * as acp from '@agentclientprotocol/sdk'
import type { AdapterProcess } from './bridge-server.js'

export interface HandshakeResult {
  readonly agentName: string | null
  readonly agentVersion: string | null
  readonly protocolVersion: number | null
  readonly raw: Record<string, unknown>
}

export interface HandshakeOptions {
  readonly adapter: AdapterProcess
  readonly workspaceRoot: string
  readonly timeoutMs?: number
}

/**
 * Performs `initialize` once, directly against the adapter's stdio, and detaches cleanly so the
 * relay that follows sees an untouched stream. Nothing else in the process may be reading stdout
 * while this runs — it is called at launch, before the WebSocket server accepts anything.
 */
export async function initializeAdapter(options: HandshakeOptions): Promise<HandshakeResult> {
  const detach: (() => void)[] = []
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer): void => controller.enqueue(new Uint8Array(chunk))
      options.adapter.stdout.on('data', onData)
      detach.push(() => options.adapter.stdout.off('data', onData))
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        options.adapter.stdin.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()))
      })
    },
  })

  const connection = acp.client({ name: 'agora-harness-bridge' }).connect(acp.ndJsonStream(writable, readable))
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`the adapter did not answer initialize within ${String(options.timeoutMs ?? 30_000)}ms`)), options.timeoutMs ?? 30_000).unref?.(),
    )
    const result = (await Promise.race([
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        cwd: options.workspaceRoot,
        mcpServers: [],
      }),
      timeout,
    ])) as Record<string, unknown>
    const info = (result['agentInfo'] ?? {}) as { name?: string; version?: string }
    return {
      agentName: info.name ?? null,
      agentVersion: info.version ?? null,
      protocolVersion: typeof result['protocolVersion'] === 'number' ? result['protocolVersion'] : null,
      raw: result,
    }
  } finally {
    connection.close?.()
    for (const off of detach) off()
  }
}

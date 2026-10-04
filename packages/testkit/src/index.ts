import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startBridge, type Bridge } from '@agora/harness-bridge'
import { sessionsDir } from '@agora/mock-agent/storage'

export const MOCK_AGENT = fileURLToPath(import.meta.resolve('@agora/mock-agent/agent'))

export function keys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519')
}

export interface LabBridge {
  readonly bridge: Bridge
  readonly home: string
  readonly workspace: string
  readonly url: string
}

export async function mockBridge(
  publicKey: KeyObject,
  podName = 'sbx-test',
  options: { home?: string; initializeDelayMs?: number; initializeInvalid?: boolean; readAtStart?: boolean; restartOnAnchor?: boolean } = {},
): Promise<LabBridge> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'bridge-'))
  const workspace = join(home, 'work')
  const bridge = await startBridge({
    port: 0,
    host: '127.0.0.1',
    adapterCommand: [
      'env',
      `HOME=${home}`,
      `AGORA_MOCK_INITIALIZE_DELAY_MS=${String(options.initializeDelayMs ?? 0)}`,
      `AGORA_MOCK_INITIALIZE_INVALID=${options.initializeInvalid ? '1' : '0'}`,
      `AGORA_MOCK_READ_AT_START=${options.readAtStart ? '1' : '0'}`,
      process.execPath,
      MOCK_AGENT,
    ],
    workspace,
    podName,
    publicKey,
    harness: 'mock',
    nativeDir: sessionsDir(home, workspace),
    restartOnAnchor: options.restartOnAnchor ?? false,
    accessFile: join(home, '.agora', 'access.json'),
    adapterStopMs: 1000,
    log: () => {},
  })
  return { bridge, home, workspace, url: `127.0.0.1:${String(bridge.port())}` }
}

/** A WebSocket client that keeps every message it received, parsed. */
export class Collector {
  readonly messages: Record<string, unknown>[] = []
  readonly socket: WebSocket
  readonly raw: string[] = []
  readonly binary: boolean[] = []
  instance: string | null = null
  closed: { code: number; reason: string } | null = null
  private waiters: (() => void)[] = []

  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers })
    this.socket.on('upgrade', (response) => { this.instance = response.headers['agora-bridge-instance'] as string ?? null })
    this.socket.on('message', (data, isBinary) => {
      this.raw.push(data.toString())
      this.binary.push(isBinary)
      try { this.messages.push(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* Raw framing tests also use non-JSON lines. */ }
      for (const wake of this.waiters.splice(0)) wake()
    })
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() }
      for (const wake of this.waiters.splice(0)) wake()
    })
    this.socket.on('error', () => {})
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve()
      this.socket.once('open', () => resolve())
      this.socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${String(res.statusCode)}`)))
      this.socket.once('error', reject)
    })
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  /** The ACP messages received, parsed. */
  acp(): Record<string, unknown>[] {
    return this.messages.filter((m) => m.jsonrpc === '2.0')
  }

  async until<T>(find: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = find()
      if (found !== undefined && found !== null && found !== false) return found
      if (Date.now() > deadline) throw new Error(`timed out; received: ${JSON.stringify(this.messages).slice(-2000)}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  response(id: unknown): Promise<Record<string, unknown>> {
    return this.until(() => this.acp().find((m) => m.id === id && m.method === undefined))
  }

  close(): void {
    this.socket.close()
  }
}

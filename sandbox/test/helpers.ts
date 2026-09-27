import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startBridge, type Bridge } from '../src/bridge/server.ts'
import { mockLayout } from '../src/shared/transcript.ts'

export const MOCK_AGENT = join(import.meta.dirname, '..', 'src', 'mock-agent', 'main.ts')

export function keys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519')
}

export interface LabBridge {
  readonly bridge: Bridge
  readonly home: string
  readonly workspace: string
  readonly url: string
}

export async function mockBridge(publicKey: KeyObject, podName = 'sbx-test', home = mkdtempSync(join(tmpdir(), 'bridge-'))): Promise<LabBridge> {
  const workspace = join(home, 'work')
  const bridge = await startBridge({
    port: 0,
    host: '127.0.0.1',
    adapterCommand: ['env', `HOME=${home}`, process.execPath, MOCK_AGENT],
    workspace,
    podName,
    publicKey,
    layout: mockLayout(home, workspace),
    log: () => {},
  })
  return { bridge, home, workspace, url: `127.0.0.1:${String(bridge.port())}` }
}

/** A WebSocket client that keeps every message it received, parsed. */
export class Collector {
  readonly messages: Record<string, unknown>[] = []
  readonly socket: WebSocket
  closed: { code: number; reason: string } | null = null
  private waiters: (() => void)[] = []

  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers })
    this.socket.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
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

  /** ACP messages carried in `{seq, acp}` envelopes (and `{local}` answers), parsed. */
  acp(): Record<string, unknown>[] {
    return this.messages
      .map((m) => (typeof m.acp === 'string' ? m.acp : typeof m.local === 'string' ? m.local : null))
      .filter((line): line is string => line !== null)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  async until<T>(find: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = find()
      if (found !== undefined && found !== null && found !== false) return found
      if (Date.now() > deadline) throw new Error(`délai dépassé ; reçu : ${JSON.stringify(this.messages).slice(-2000)}`)
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

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import WebSocket from 'ws'
import { mintBridgeToken } from '@agora/acp'
import { startBridgeServer, type AdapterProcess } from '../src/bridge-server.js'

const SECRET = 'test-secret'
const INCARNATION = 'inc-1'

function fakeAdapter(): AdapterProcess & { readonly stdin: PassThrough; readonly stdout: PassThrough; exit(code: number | null): void } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve
  })
  return {
    stdin,
    stdout,
    exited,
    kill: () => {},
    exit: (code) => resolveExit({ code, signal: null }),
  }
}

async function connectWs(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers = token !== undefined ? { authorization: `Bearer ${token}` } : {}
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())))
}

test('bridge-server: a connection without a bearer token is rejected before reaching the adapter', async () => {
  const adapter = fakeAdapter()
  const server = startBridgeServer({ port: 0, incarnation: INCARNATION, bridgeAuthSecret: SECRET, adapter })
  try {
    await assert.rejects(() => connectWs(server.address()), /status 401/)
  } finally {
    await server.stop()
  }
})

test('bridge-server: a valid token round-trips bytes both ways, opaquely', async () => {
  const adapter = fakeAdapter()
  const server = startBridgeServer({ port: 0, incarnation: INCARNATION, bridgeAuthSecret: SECRET, adapter })
  try {
    const token = mintBridgeToken(INCARNATION, SECRET)
    const ws = await connectWs(server.address(), token)
    adapter.stdout.write('{"jsonrpc":"2.0","method":"session/update"}\n')
    const fromAdapter = await nextMessage(ws)
    assert.match(fromAdapter, /session\/update/)

    const received = new Promise<Buffer>((resolve) => adapter.stdin.once('data', resolve))
    ws.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    const toAdapter = await received
    assert.match(toAdapter.toString(), /initialize/)
    ws.close()
  } finally {
    await server.stop()
  }
})

test('bridge-server: a token for another incarnation is refused', async () => {
  const adapter = fakeAdapter()
  const server = startBridgeServer({ port: 0, incarnation: INCARNATION, bridgeAuthSecret: SECRET, adapter })
  try {
    const token = mintBridgeToken('some-other-incarnation', SECRET)
    await assert.rejects(() => connectWs(server.address(), token), /status 403/)
  } finally {
    await server.stop()
  }
})

test('bridge-server: closing the WebSocket never kills the adapter — a reconnect attaches to the same still-running process', async () => {
  const adapter = fakeAdapter()
  const server = startBridgeServer({ port: 0, incarnation: INCARNATION, bridgeAuthSecret: SECRET, adapter })
  try {
    const token = mintBridgeToken(INCARNATION, SECRET)
    const first = await connectWs(server.address(), token)
    first.close()
    await new Promise((r) => setTimeout(r, 50))

    const second = await connectWs(server.address(), token)
    adapter.stdout.write('{"still":"alive"}\n')
    const message = await nextMessage(second)
    assert.match(message, /still.*alive/)
    second.close()
  } finally {
    await server.stop()
  }
})

test('bridge-server: once the adapter process exits, a new connection is refused rather than silently pointed at nothing', async () => {
  const adapter = fakeAdapter()
  const server = startBridgeServer({ port: 0, incarnation: INCARNATION, bridgeAuthSecret: SECRET, adapter })
  try {
    adapter.exit(0)
    await new Promise((r) => setTimeout(r, 50))
    const token = mintBridgeToken(INCARNATION, SECRET)
    const ws = await connectWs(server.address(), token)
    const closeCode = await new Promise<number>((resolve) => ws.once('close', resolve))
    assert.equal(closeCode, 1011)
  } finally {
    await server.stop()
  }
})

test('S13: only ONE client is attached at a time — a second connection supersedes the first, and frames never reach both', async () => {
  // The adapter answers by JSON-RPC id, and every ACP connection numbers its requests from 0. With
  // two sockets attached, both received every frame: live, a response to one connection's request 0
  // was delivered to the other's request 0 as well, the control plane logged
  // `Got response to unknown request 0`, and the prompt whose answer went astray stayed `reserved`
  // for ever — which the one-turn-per-Workstream gate then read as a turn in flight, so that
  // Workstream could never be prompted again.
  const adapter = fakeAdapter()
  const server = startBridgeServer({ port: 0, incarnation: INCARNATION, bridgeAuthSecret: SECRET, adapter })
  try {
    const token = mintBridgeToken(INCARNATION, SECRET)
    const first = await connectWs(server.address(), token)
    const firstClosed = new Promise<number>((resolve) => first.on('close', (code: number) => resolve(code)))
    const firstFrames: string[] = []
    first.on('message', (data: Buffer) => firstFrames.push(data.toString()))

    const second = await connectWs(server.address(), token)
    assert.equal(await firstClosed, 1012, 'the superseded connection is closed, not left half-listening')

    adapter.stdout.write('{"jsonrpc":"2.0","id":0,"result":{}}\n')
    assert.match(await nextMessage(second), /"id":0/)
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(firstFrames, [], 'the superseded connection receives nothing at all')

    // And the adapter itself is untouched — that is the whole point of it outliving a socket.
    const received = new Promise<Buffer>((resolve) => adapter.stdin.once('data', resolve))
    second.send('{"jsonrpc":"2.0","id":1,"method":"session/list"}\n')
    assert.match((await received).toString(), /session\/list/)
    second.close()
  } finally {
    await server.stop()
  }
})

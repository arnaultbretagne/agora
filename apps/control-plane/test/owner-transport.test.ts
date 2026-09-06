import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import type { OwnerRequest } from '@agora/owner-requests'
import { createHttpOwnerTransport } from '../src/owner-transport.js'

function startFakeOwner(respond: (request: OwnerRequest) => { status: number; body: unknown }): Promise<{ server: Server; url: string; requests: OwnerRequest[] }> {
  const requests: OwnerRequest[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OwnerRequest
        requests.push(request)
        const { status, body } = respond(request)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, requests })
    })
  })
}

function request(overrides: Partial<OwnerRequest> = {}): OwnerRequest {
  return { epoch: 1, workstreamId: 'w1', attemptKey: 'a1', operation: 'create_pod', target: { kind: 'reserved', id: 'inc-1' }, payload: {}, payloadDigest: 'd', revisionSet: {}, ...overrides }
}

test('routes create_pod/cleanup_pod/gate_release to runtime-control and everything else to broker', async () => {
  const runtimeControl = await startFakeOwner(() => ({ status: 200, body: { kind: 'completed', result: {} } }))
  const broker = await startFakeOwner(() => ({ status: 200, body: { kind: 'completed', result: {} } }))
  const transport = createHttpOwnerTransport({ runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url })
  try {
    await transport.send(transport.route('create_pod'), request({ operation: 'create_pod' }))
    await transport.send(transport.route('cleanup_pod'), request({ operation: 'cleanup_pod' }))
    await transport.send(transport.route('gate_release'), request({ operation: 'gate_release' }))
    await transport.send(transport.route('attach_grant'), request({ operation: 'attach_grant' }))
    await transport.send(transport.route('detach_grant'), request({ operation: 'detach_grant' }))
    assert.equal(runtimeControl.requests.length, 3)
    assert.equal(broker.requests.length, 2)
  } finally {
    runtimeControl.server.close()
    broker.server.close()
  }
})

test('an owner response is passed through verbatim', async () => {
  const runtimeControl = await startFakeOwner(() => ({ status: 200, body: { kind: 'rejected_stale_epoch', recordedEpoch: 5 } }))
  const broker = await startFakeOwner(() => ({ status: 200, body: {} }))
  const transport = createHttpOwnerTransport({ runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url })
  try {
    const response = await transport.send('runtime-control', request())
    assert.deepEqual(response, { kind: 'rejected_stale_epoch', recordedEpoch: 5 })
  } finally {
    runtimeControl.server.close()
    broker.server.close()
  }
})

test('an unreachable owner resolves to unknown, never a thrown exception (CONT-005/ENGINE-008 shape)', async () => {
  const transport = createHttpOwnerTransport({ runtimeControlBaseUrl: 'http://127.0.0.1:65533', brokerBaseUrl: 'http://127.0.0.1:65533' })
  const response = await transport.send('runtime-control', request())
  assert.equal(response.kind, 'unknown')
})

test('a non-2xx HTTP response resolves to unknown with the owner\'s own detail, not a rejection', async () => {
  const runtimeControl = await startFakeOwner(() => ({ status: 500, body: { type: 'about:blank', title: 'Internal error', status: 500, detail: 'boom' } }))
  const broker = await startFakeOwner(() => ({ status: 200, body: {} }))
  const transport = createHttpOwnerTransport({ runtimeControlBaseUrl: runtimeControl.url, brokerBaseUrl: broker.url })
  try {
    const response = await transport.send('runtime-control', request())
    assert.equal(response.kind, 'unknown')
    assert.equal((response as { detail: string }).detail, 'boom')
  } finally {
    runtimeControl.server.close()
    broker.server.close()
  }
})

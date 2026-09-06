import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { test } from 'node:test'
import { answerCaptureRequest, answerProofRequest, placeOfferedSave } from '../src/custody-agent.js'
import { FakeDriver } from './fake-driver.js'

interface Posted {
  readonly url: string
  readonly headers: NodeJS.Dict<string | string[]>
  readonly bytes: Uint8Array
}

function startCustodySink(payload?: Uint8Array): Promise<{ server: Server; url: string; posts: Posted[] }> {
  const posts: Posted[] = []
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res) => {
      if ((req.url ?? '').startsWith('/custody/payload')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return void res.end(Buffer.from(payload ?? new Uint8Array()))
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        posts.push({ url: req.url ?? '', headers: req.headers, bytes: new Uint8Array(Buffer.concat(chunks)) })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/custody`, posts })
    })
  })
}

test('a capture request is answered with the driver\'s own bytes and metadata', async () => {
  const bytes = new TextEncoder().encode('the native state')
  const driver = new FakeDriver({ bytes })
  const { server, url, posts } = await startCustodySink()
  try {
    const outcome = await answerCaptureRequest({ custodyUrlBase: url, driver, podUid: 'pod-uid-1' }, { contextId: 'ctx-1', processGeneration: 2, token: 'token-1' })

    assert.equal(outcome, 'captured')
    assert.deepEqual(driver.captured, [{ podUid: 'pod-uid-1', processGeneration: 2, contextId: 'ctx-1' }], 'the cut is the one the request named, never one the Pod chose')
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]!.bytes, bytes, 'the payload crosses byte for byte')
    assert.equal(posts[0]!.headers['x-agora-capture-token'], 'token-1')
    assert.equal(posts[0]!.headers['x-agora-driver-revision'], 'fake-1')
    assert.equal(posts[0]!.headers['x-agora-format-id'], 'fake-format')
    assert.equal(posts[0]!.headers['x-agora-checksum'], `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  } finally {
    server.close()
  }
})

test('a refused cut is reported as an answer, not left as silence (OFF-001)', async () => {
  const driver = new FakeDriver({ refuseCapture: 'the transcript was still changing' })
  const { server, url, posts } = await startCustodySink()
  try {
    const outcome = await answerCaptureRequest({ custodyUrlBase: url, driver, podUid: 'pod-uid-1' }, { contextId: 'ctx-1', processGeneration: 0, token: 'token-1' })

    assert.equal(outcome, 'refused')
    assert.equal(String(posts[0]!.headers['x-agora-refused']), 'the transcript was still changing')
    assert.equal(posts[0]!.bytes.byteLength, 0)
  } finally {
    server.close()
  }
})

test('an error that is NOT a driver refusal propagates rather than being reported as one', async () => {
  const driver = new FakeDriver()
  const broken = { ...driver, capture: async () => Promise.reject(new Error('the disk went away')) } as unknown as FakeDriver
  const { server, url, posts } = await startCustodySink()
  try {
    await assert.rejects(
      answerCaptureRequest({ custodyUrlBase: url, driver: broken, podUid: 'pod-uid-1' }, { contextId: 'ctx-1', processGeneration: 0, token: 'token-1' }),
      /the disk went away/,
    )
    assert.equal(posts.length, 0, 'an outage is not an answer: reporting it as a refusal would end the wait on a lie')
  } finally {
    server.close()
  }
})

test('a placement fetches the offered bytes, places them, and reports what actually landed', async () => {
  const bytes = new TextEncoder().encode('restored state')
  const driver = new FakeDriver({ placedPath: '/home/agent/placed.jsonl' })
  const { server, url, posts } = await startCustodySink(bytes)
  try {
    await placeOfferedSave({ custodyUrlBase: url, driver }, { saveId: 'save-1', checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteLength: bytes.byteLength, token: 'token-1' }, () => {})

    assert.deepEqual(driver.restored, [bytes])
    const report = JSON.parse(new TextDecoder().decode(posts[0]!.bytes)) as { path: string; checksum: string; byteLength: number }
    assert.equal(report.path, '/home/agent/placed.jsonl', 'what the driver measured on disk, not what the offer claimed')
    assert.equal(report.byteLength, bytes.byteLength)
  } finally {
    server.close()
  }
})

test('a proof is re-taken from the driver every time it is asked — never a cached verdict (CONT-006)', async () => {
  const driver = new FakeDriver({ proof: { kind: 'incorporated', evidence: { seen: true } } })
  const { server, url, posts } = await startCustodySink()
  try {
    const digest = randomUUID().replaceAll('-', '')
    const first = await answerProofRequest({ custodyUrlBase: url, driver }, { contextId: 'ctx-1', processGeneration: 0, w: 0, h: 5, handoffDigest: digest, token: 't' })
    const second = await answerProofRequest({ custodyUrlBase: url, driver }, { contextId: 'ctx-1', processGeneration: 0, w: 0, h: 5, handoffDigest: digest, token: 't' })

    assert.equal(first, 'incorporated')
    assert.equal(second, 'incorporated')
    assert.equal(driver.proved.length, 2, 'asked twice, answered twice: a stored receipt is not live proof')
    assert.equal(driver.proved[0]!.handoffDigest, digest)
    assert.equal(posts.length, 2)
  } finally {
    server.close()
  }
})

test('an empty-range proof carries no digest, and the driver is still the one that decides', async () => {
  const driver = new FakeDriver({ proof: { kind: 'incorporated', evidence: { range: 'empty' } } })
  const { server, url } = await startCustodySink()
  try {
    await answerProofRequest({ custodyUrlBase: url, driver }, { contextId: 'ctx-1', processGeneration: 0, w: 4, h: 4, handoffDigest: null, token: 't' })
    assert.equal(driver.proved[0]!.handoffDigest, undefined, 'absent, not null: the descriptor simply has no digest to look for')
  } finally {
    server.close()
  }
})

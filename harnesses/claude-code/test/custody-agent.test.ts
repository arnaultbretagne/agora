import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { answerCaptureRequest } from '../src/custody-agent.js'
import { transcriptPath } from '../src/driver.js'

const WORKSPACE_ROOT = '/home/agent/work'

interface PostedCapture {
  readonly headers: NodeJS.Dict<string | string[]>
  readonly bytes: Uint8Array
}

function startCustodySink(): Promise<{ server: Server; url: string; posts: PostedCapture[] }> {
  const posts: PostedCapture[] = []
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        posts.push({ headers: req.headers, bytes: new Uint8Array(Buffer.concat(chunks)) })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ captured: true }))
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
  const home = await mkdtemp(join(tmpdir(), 'agora-agent-'))
  const contextId = randomUUID()
  const bytes = new TextEncoder().encode(`${JSON.stringify({ type: 'user', sessionId: contextId, message: { role: 'user', content: 'hi' } })}\n`)
  const path = transcriptPath({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, contextId })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  const { server, url, posts } = await startCustodySink()

  try {
    const outcome = await answerCaptureRequest(
      { evidenceUrl: 'unused', custodyUrlBase: url, harnessHome: home, workspaceRoot: WORKSPACE_ROOT, podUid: 'pod-uid-1' },
      { contextId, processGeneration: 2, token: 'token-1' },
    )

    assert.equal(outcome, 'captured')
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]!.bytes, bytes, 'the payload is the transcript, byte for byte')
    const headers = posts[0]!.headers
    assert.equal(headers['x-agora-capture-token'], 'token-1')
    assert.equal(headers['x-agora-checksum'], `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    assert.equal(headers['x-agora-format-id'], 'claude-code-transcript')
    assert.equal(headers['x-agora-driver-revision'], 'claude-code-transcript-1')
    // The generation the request named, not one the Pod chose for itself: it is part of the key.
    assert.deepEqual(JSON.parse(String(headers['x-agora-native-origin'])), { podUid: 'pod-uid-1', processGeneration: 2, contextId })
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('a refused cut is reported as an answer, not left as silence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agora-agent-'))
  const { server, url, posts } = await startCustodySink()

  try {
    // No transcript at all: the driver refuses, and the control plane is on a shutdown budget that
    // must not be spent waiting for a capture that is never coming (OFF-001).
    const outcome = await answerCaptureRequest(
      { evidenceUrl: 'unused', custodyUrlBase: url, harnessHome: home, workspaceRoot: WORKSPACE_ROOT, podUid: 'pod-uid-1' },
      { contextId: randomUUID(), processGeneration: 0, token: 'token-1' },
    )

    assert.equal(outcome, 'refused')
    assert.equal(posts.length, 1)
    assert.match(String(posts[0]!.headers['x-agora-refused']), /no transcript for context/)
    assert.equal(posts[0]!.bytes.byteLength, 0)
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }
})

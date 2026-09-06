import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { waitForGateRelease } from '../src/launch.js'
import { FakeDriver } from './fake-driver.js'

type FakeResponse = { readonly kind: 'destroy' } | { readonly kind: 'respond'; readonly status: number; readonly seam: { readonly released: boolean } | null }

function startEvidenceServer(responses: readonly FakeResponse[]): Promise<{ server: Server; url: string }> {
  let call = 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const response = responses[Math.min(call, responses.length - 1)]!
      call += 1
      if (response.kind === 'destroy') {
        req.socket.destroy()
        return
      }
      res.writeHead(response.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seam: response.seam }))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/evidence` })
    })
  })
}

test('waitForGateRelease resolves as soon as the seam reports released:true', async () => {
  const { server, url } = await startEvidenceServer([
    { kind: 'respond', status: 200, seam: { released: false } },
    { kind: 'respond', status: 200, seam: { released: false } },
    { kind: 'respond', status: 200, seam: { released: true } },
  ])
  try {
    await waitForGateRelease({ evidenceUrl: url, pollIntervalMs: 10 })
  } finally {
    server.close()
  }
})

test('waitForGateRelease keeps polling through a 404 (Pod not yet visible to itself) without throwing', async () => {
  const { server, url } = await startEvidenceServer([
    { kind: 'respond', status: 404, seam: null },
    { kind: 'respond', status: 404, seam: null },
    { kind: 'respond', status: 200, seam: { released: true } },
  ])
  try {
    await waitForGateRelease({ evidenceUrl: url, pollIntervalMs: 10 })
  } finally {
    server.close()
  }
})

test('waitForGateRelease keeps polling through a network failure (connection reset) without throwing', async () => {
  const { server, url } = await startEvidenceServer([{ kind: 'destroy' }, { kind: 'destroy' }, { kind: 'respond', status: 200, seam: { released: true } }])
  const logs: string[] = []
  try {
    await waitForGateRelease({ evidenceUrl: url, pollIntervalMs: 10, onLog: (m) => logs.push(m) })
    assert.ok(logs.length >= 2, 'each failed poll is logged, not thrown')
  } finally {
    server.close()
  }
})

/**
 * A stand-in for runtime-control's custody endpoints, with the same ordering rule: the seam stays
 * shut until a placement report matching the Save's own checksum arrives. What this exercises is the
 * harness half of that handshake — fetch, place through the driver, report, and only then launch.
 */
function startCustodyServer(bytes: Uint8Array, options: { readonly rejectFirstReport?: boolean } = {}): Promise<{
  server: Server
  evidenceUrl: string
  custodyUrl: string
  reports: { checksum: string; byteLength: number; path: string }[]
  /** Test-only escape hatch: opens the seam without a placement, so a waiting test can finish. */
  release: () => void
}> {
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const reports: { checksum: string; byteLength: number; path: string }[] = []
  let released = false
  let rejectionsLeft = options.rejectFirstReport === true ? 1 : 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/evidence') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ seam: { released }, custody: released ? null : { saveId: 'save-1', checksum, byteLength: bytes.byteLength, token: 'token-1' } }))
      }
      if (url.pathname === '/custody/payload') {
        if (url.searchParams.get('token') !== 'token-1') {
          res.writeHead(403)
          return void res.end()
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return void res.end(Buffer.from(bytes))
      }
      if (url.pathname === '/custody/placement') {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        return void req.on('end', () => {
          const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { checksum: string; byteLength: number; path: string }
          reports.push(report)
          if (rejectionsLeft > 0) {
            rejectionsLeft -= 1
            res.writeHead(409, { 'content-type': 'application/problem+json' })
            return void res.end(JSON.stringify({ title: 'Placement rejected' }))
          }
          released = report.checksum === checksum && report.byteLength === bytes.byteLength
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ placed: true }))
        })
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        server,
        evidenceUrl: `http://127.0.0.1:${port}/evidence`,
        custodyUrl: `http://127.0.0.1:${port}/custody`,
        reports,
        release: () => {
          released = true
        },
      })
    })
  })
}

function payloadBytes(contextId: string): Uint8Array {
  return new TextEncoder().encode(`native state for ${contextId}`)
}

test('a Save offered at the seam is fetched and placed before the gate ever opens', async () => {
  const contextId = randomUUID()
  const bytes = payloadBytes(contextId)
  const driver = new FakeDriver({ placedPath: `/home/agent/${contextId}.jsonl` })
  const { server, evidenceUrl, custodyUrl, reports } = await startCustodyServer(bytes)
  try {
    await waitForGateRelease({ evidenceUrl, pollIntervalMs: 10, custody: { driver, placementUrlBase: custodyUrl } })

    assert.deepEqual(driver.restored, [bytes], 'the bytes reached the driver before the gate opened')
    assert.equal(reports.length, 1)
    assert.equal(reports[0]!.path, `/home/agent/${contextId}.jsonl`, 'the report names what the driver actually wrote')
  } finally {
    server.close()
  }
})

test('a refused placement report is retried at the seam rather than launching anyway', async () => {
  const bytes = payloadBytes(randomUUID())
  const driver = new FakeDriver()
  const { server, evidenceUrl, custodyUrl, reports } = await startCustodyServer(bytes, { rejectFirstReport: true })
  try {
    await waitForGateRelease({ evidenceUrl, pollIntervalMs: 10, custody: { driver, placementUrlBase: custodyUrl } })
    assert.equal(reports.length, 2, 'the same attempt retries its own placement; it never gives up and launches')
  } finally {
    server.close()
  }
})

test('a Save offered to a Pod with no custody paths keeps waiting and says so, instead of launching', async () => {
  const bytes = payloadBytes(randomUUID())
  const { server, evidenceUrl, reports, release } = await startCustodyServer(bytes)
  const logs: string[] = []
  try {
    const waiting = waitForGateRelease({ evidenceUrl, pollIntervalMs: 5, onLog: (message) => logs.push(message) })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(reports.length, 0, 'nothing was placed, and nothing was reported as placed')
    assert.ok(logs.some((message) => message.includes('no custody paths were configured')))
    assert.ok(logs.length >= 2, 'it keeps saying so on every poll rather than failing silently')
    release()
    await waiting
  } finally {
    server.close()
  }
})

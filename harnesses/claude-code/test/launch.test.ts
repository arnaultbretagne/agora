import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { waitForGateRelease } from '../src/launch.js'

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

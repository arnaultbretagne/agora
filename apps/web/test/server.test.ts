import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { createWebServer } from '../src/server.js'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected address')
  return `http://127.0.0.1:${address.port}`
}

test('serves the shell, the compiled client and refuses anything else', async (t) => {
  const server = createWebServer()
  const base = await listen(server)
  t.after(() => server.close())

  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await index.text(), /<script type="module" src="\/client\/app.js">/)

  const app = await fetch(`${base}/client/app.js`)
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type') ?? '', /text\/javascript/)

  assert.equal((await fetch(`${base}/styles.css`)).status, 200)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal((await fetch(`${base}/package.json`)).status, 404, 'only allow-listed extensions are served')
  assert.equal((await fetch(`${base}/client/..%2F..%2Fpackage.json`)).status, 404, 'no traversal')
  assert.equal((await fetch(`${base}/nested/path.css`)).status, 404, 'no nested public paths')
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405)
})

test('answers 503 on /v1 without a configured control plane', async (t) => {
  const server = createWebServer()
  const base = await listen(server)
  t.after(() => server.close())
  const res = await fetch(`${base}/v1/workstreams`)
  assert.equal(res.status, 503)
  assert.deepEqual(await res.json(), { error: 'control_plane_not_configured' })
})

test('relays /v1 opaquely: method, path, query, headers, body and status pass through', async (t) => {
  const seen: { method: string | undefined; url: string | undefined; auth: string | undefined; body: string } = { method: undefined, url: undefined, auth: undefined, body: '' }
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.method = req.method
      seen.url = req.url
      seen.auth = req.headers['authorization']
      seen.body = body
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' })
      res.end('{"created":true}')
    })
  })
  const upstreamBase = await listen(upstream)
  t.after(() => upstream.close())

  const server = createWebServer({ controlPlaneUrl: upstreamBase })
  const base = await listen(server)
  t.after(() => server.close())

  const res = await fetch(`${base}/v1/workstreams?after=3`, {
    method: 'POST',
    headers: { authorization: 'Bearer p', 'content-type': 'application/json' },
    body: '{"title":"x"}',
  })
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('x-upstream'), 'yes')
  assert.deepEqual(await res.json(), { created: true })
  assert.deepEqual(seen, { method: 'POST', url: '/v1/workstreams?after=3', auth: 'Bearer p', body: '{"title":"x"}' })
})

test('reports an unreachable control plane as 502', async (t) => {
  const server = createWebServer({ controlPlaneUrl: 'http://127.0.0.1:1' })
  const base = await listen(server)
  t.after(() => server.close())
  const res = await fetch(`${base}/v1/workstreams`)
  assert.equal(res.status, 502)
  assert.equal(((await res.json()) as { error: string }).error, 'control_plane_unreachable')
})

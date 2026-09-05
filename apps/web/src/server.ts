/**
 * Static shell for the Web UI plus an opaque relay of `/v1/*` to the control plane.
 *
 * This process holds no product authority (ADR 0001, AGENTS.md trust boundaries): it serves reviewed
 * files by extension allow-list and forwards API traffic unchanged. It never reads the database,
 * talks to a harness, OneCLI or Kubernetes.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'

export interface WebServerOptions {
  /** Base URL of the control plane API; when absent, `/v1/*` answers 503. */
  readonly controlPlaneUrl?: string
  /** Directory holding `index.html`, stylesheets and the favicon. */
  readonly publicDir?: URL
  /** Directory holding the compiled browser modules served under `/client/`. */
  readonly clientDir?: URL
}

const DEFAULT_PUBLIC_DIR = new URL('../../public/', import.meta.url)
const DEFAULT_CLIENT_DIR = new URL('../client/', import.meta.url)

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

// Hop-by-hop headers are not forwarded by a relay (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'])

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function sendStaticFile(res: ServerResponse, base: URL, relativePath: string): Promise<boolean> {
  const extension = relativePath.slice(relativePath.lastIndexOf('.'))
  const contentType = CONTENT_TYPES[extension]
  if (!contentType || relativePath.includes('..') || relativePath.includes('\\')) return false
  const target = new URL(relativePath, base)
  if (!target.href.startsWith(base.href)) return false
  let body: Buffer
  try {
    body = await readFile(target)
  } catch {
    return false
  }
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' })
  res.end(body)
  return true
}

async function handleStatic(path: string, res: ServerResponse, options: WebServerOptions): Promise<boolean> {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR
  const clientDir = options.clientDir ?? DEFAULT_CLIENT_DIR
  if (path === '/') return sendStaticFile(res, publicDir, 'index.html')
  if (path.startsWith('/client/')) return sendStaticFile(res, clientDir, path.slice('/client/'.length))
  if (!path.includes('/', 1)) return sendStaticFile(res, publicDir, path.slice(1))
  return false
}

async function relay(req: IncomingMessage, res: ServerResponse, upstream: string): Promise<void> {
  const target = new URL(req.url ?? '/', upstream)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      redirect: 'manual',
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
    } as RequestInit)
  } catch (error) {
    sendJson(res, 502, { error: 'control_plane_unreachable', detail: error instanceof Error ? error.message : String(error) })
    return
  }
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value
  })
  res.writeHead(response.status, responseHeaders)
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) res.write(chunk)
  res.end()
}

export function createWebServer(options: WebServerOptions = {}): Server {
  return createHttpServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/healthz') return sendJson(res, 200, { ok: true })
      if (path === '/v1' || path.startsWith('/v1/')) {
        if (!options.controlPlaneUrl) return sendJson(res, 503, { error: 'control_plane_not_configured' })
        return relay(req, res, options.controlPlaneUrl)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' })
      if (await handleStatic(path, res, options)) return
      sendJson(res, 404, { error: 'not_found' })
    })().catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.destroy()
      console.error(error)
    })
  })
}

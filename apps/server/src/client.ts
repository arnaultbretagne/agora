// The client (docs/specs/assistant-ui.md), built by apps/web, served at `/`: its files as they are,
// and its page for every other path that is not the API's, the health check's or the test page's,
// so that a Workstream's address opens the client on it.
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

// Nothing inline but styles (the components set some), nothing from elsewhere.
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'"

export function serveClient(root: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://agora').pathname
    if (req.method !== 'GET' || path.startsWith('/api/') || path === '/healthz' || path === '/test' || path.startsWith('/test/')) return false
    const asked = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '')
    const file = join(root, asked)
    // A file of the build, or the page; never anything outside the build.
    const inside = file.startsWith(root + sep) && extname(asked) !== ''
    const target = inside ? file : join(root, 'index.html')
    let content: Buffer
    try {
      content = await readFile(target)
    } catch {
      if (inside) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n')
        return true
      }
      return false
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      // Vite names its assets after their content: they never change under the same name.
      'cache-control': target.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
      'content-security-policy': POLICY,
      'x-content-type-options': 'nosniff',
    })
    res.end(content)
    return true
  }
}

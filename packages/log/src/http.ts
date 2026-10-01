// Admin lab surface. Trusted product identity and ownership authorization have their own contract.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { LogDriver } from './driver.ts'
import type { CredentialSource } from '@agora/executions'
import type { Command } from './store.ts'
import { uuid, object, decode, encode, cursor } from './json.ts'
import { MAX_LINE } from './acp.ts'
import { gatewayCredentials } from './credentials.ts'
export async function logHttp(
  driver: LogDriver,
  req: IncomingMessage,
  res: ServerResponse,
  credentials?: CredentialSource,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://agora')
  if (url.pathname === '/api/log-json.js' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' })
    res.end(await readFile(createRequire(import.meta.url).resolve('lossless-json')))
    return true
  }
  if (!url.pathname.startsWith('/api/workstreams')) return false
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(encode(value))
  }
  const body = async () => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_LINE) throw new Error('invalid_body')
      chunks.push(chunk as Buffer)
    }
    const value = object(decode(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
    if (!value) throw new Error('invalid_body')
    return value
  }
  try {
    if (req.method === 'POST' && url.pathname === '/api/workstreams') {
      const input = await body(),
        id = uuid(input.id),
        owner = uuid(input.owner)
      await driver.options.store.create(id, owner)
      reply(200, { id })
      return true
    }
    const route = /^\/api\/workstreams\/([^/]+)\/(commands|control|thread|entries|credentials)$/.exec(url.pathname)
    if (!route) {
      reply(404, { reason: 'unknown_route' })
      return true
    }
    const workstream = uuid(route[1]),
      verb = route[2]
    if (req.method === 'POST' && verb === 'commands') {
      const input = await body(),
        target = object(input.target),
        content = object(input.body)
      if (
        !['Create', 'Write', 'Cancel', 'RespondPermission', 'Stop'].includes(String(input.kind)) ||
        !target ||
        !content
      )
        throw new Error('invalid_body')
      const answer = await driver.command(workstream, {
        id: uuid(input.id),
        kind: input.kind as Command['kind'],
        target,
        body: content,
      })
      reply(answer.accepted ? 200 : 409, answer)
      return true
    }
    if (req.method === 'POST' && verb === 'control') {
      const input = await body(),
        params = object(input.params)
      if (typeof input.method !== 'string' || !params) throw new Error('invalid_body')
      const requestId = await driver.control(workstream, uuid(input.execution), input.method, params)
      reply(200, { requestId })
      return true
    }
    if (req.method === 'POST' && verb === 'credentials') {
      if (!credentials) {
        reply(503, { reason: 'credentials_unavailable' })
        return true
      }
      const input = await body(),
        execution = uuid(input.execution)
      const secret = await gatewayCredentials(driver.options.store, driver.options.kube, credentials)(workstream, execution)
      if (secret) await driver.attachCredentials(workstream, execution, secret)
      reply(200, { accepted: true })
      return true
    }
    if (req.method === 'GET' && verb === 'entries') {
      reply(200, await driver.options.store.entries(workstream))
      return true
    }
    if (req.method === 'GET' && verb === 'thread') {
      const after = url.searchParams.get('after') ?? '0'
      cursor(after)
      await driver.projections.run(workstream)
      const snapshot = await driver.projections.snapshot(workstream, after)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      let closed = false
      res.on('close', () => {
        closed = true
      })
      const send = async (value: unknown) => {
        if (closed) return
        if (!res.write(`data: ${encode(value)}\n\n`))
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done)
              res.off('close', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
          })
      }
      for (const row of snapshot.rows) await send({ type: 'snapshot', ...row })
      await send({ type: 'snapshot-end', position: snapshot.end })
      let position = snapshot.end
      while (!closed) {
        const rows = await driver.projections.tail(workstream, position)
        for (const row of rows) {
          await send({ type: 'live', ...row })
          position = row.position
        }
        if (!rows.length)
          await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer)
                res.off('close', done)
                resolve()
              },
              timer = setTimeout(done, 250)
            res.once('close', done)
          })
      }
      return true
    }
    reply(405, { reason: 'method_refused' })
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    const validation = [
      'invalid_body',
      'invalid_identifier',
      'invalid_cursor',
      'future_cursor',
      'use_command',
      'control_refused',
      'invalid_json',
      'duplicate_key',
    ]
    if (!res.headersSent)
      reply(validation.includes(reason) || error instanceof SyntaxError ? 400 : 503, {
        reason: validation.includes(reason) ? reason : 'unavailable',
      })
    else res.destroy()
    return true
  }
}

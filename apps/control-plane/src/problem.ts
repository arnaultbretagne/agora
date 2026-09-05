import type { ServerResponse } from 'node:http'

export interface ProblemBody {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
}

export function sendProblem(res: ServerResponse, status: number, title: string, detail: string): void {
  const body: ProblemBody = { type: 'about:blank', title, status, detail }
  res.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

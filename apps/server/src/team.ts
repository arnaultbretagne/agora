// A team launched from the client (docs/specs/flows.md, "Launching from Agora"): the lead's Workstream,
// the person's, created here; then the flow `lead` asked of Prefect to run on it, the members'
// Workstreams going to the person's agents' folder. Prefect is reached in-cluster; nothing here waits
// for the run, which answers in the lead's Workstream.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { decode, encode, folderOwner, identity, object, uuid, type LogStore } from '@agora/log'

export interface TeamOptions {
  /** Prefect's API, e.g. `http://prefect-server.prefect.svc.cluster.local:4200/api`. */
  readonly prefect: string
  /** The deployment the run comes from: `<flow>/<deployment>`. */
  readonly deployment: string
  /** Prefect's UI, for the run's address; none without it. */
  readonly ui?: string
}

/** TEAM_PREFECT_API, TEAM_DEPLOYMENT and TEAM_PREFECT_UI; no team without the first. */
export function teamFrom(env: NodeJS.ProcessEnv): TeamOptions | undefined {
  const prefect = env.TEAM_PREFECT_API
  if (prefect === undefined || prefect === '') return undefined
  const deployment = env.TEAM_DEPLOYMENT ?? 'lead/main'
  if (!/^[^/]+\/[^/]+$/.test(deployment)) throw new Error('TEAM_DEPLOYMENT must be <flow>/<deployment>')
  return {
    prefect: prefect.replace(/\/$/, ''),
    deployment,
    ...(env.TEAM_PREFECT_UI ? { ui: env.TEAM_PREFECT_UI.replace(/\/$/, '') } : {}),
  }
}

const MAX_BODY = 64 * 1024

export function teamHttp(options: TeamOptions | undefined, store: LogStore): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://agora')
    if (url.pathname !== '/api/teams') return false
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(encode(value))
      return true
    }
    if (options === undefined) return reply(404, { reason: 'teams_unavailable' })
    if (req.method === 'GET') return reply(200, { available: true })
    if (req.method !== 'POST') return reply(405, { reason: 'method_not_allowed' })
    let input: Record<string, unknown>
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_BODY) throw new Error('too large')
        chunks.push(chunk as Buffer)
      }
      input = object(decode(Buffer.concat(chunks).toString('utf8'))) ?? {}
    } catch {
      return reply(400, { reason: 'invalid_body' })
    }
    const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
    if (goal === '' || goal.length > 4000) return reply(400, { reason: 'invalid_goal' })
    let id: string
    try {
      id = uuid(input.id)
    } catch {
      return reply(400, { reason: 'invalid_identifier' })
    }
    // The person the proxy passes; the body's owner without one, as for a Workstream. The members go
    // to the person's agents' folder; without the proxy, to the owner.
    const header = req.headers['x-forwarded-email']
    let owner: string
    try {
      owner = typeof header === 'string' && header !== '' ? identity('owner', header) : uuid(input.owner)
    } catch {
      return reply(400, { reason: 'invalid_owner' })
    }
    const members = typeof header === 'string' && header !== '' ? folderOwner('agents', header) : owner
    try {
      await store.create(id, owner)
    } catch (error) {
      if (error instanceof Error && error.message === 'workstream_conflict') return reply(409, { reason: 'workstream_conflict' })
      throw error
    }
    const [flow, deployment] = options.deployment.split('/') as [string, string]
    try {
      const found = await fetch(`${options.prefect}/deployments/name/${encodeURIComponent(flow)}/${encodeURIComponent(deployment)}`)
      if (!found.ok) return reply(502, { reason: 'team_deployment_missing' })
      const { id: deploymentId } = (await found.json()) as { id: string }
      // The Workstream's id as the idempotency key: the same launch sent again finds the same run.
      const created = await fetch(`${options.prefect}/deployments/${deploymentId}/create_flow_run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parameters: { goal, lead_workstream: id, owner, members_owner: members },
          idempotency_key: `agora-team-${id}`,
        }),
      })
      if (!created.ok) return reply(502, { reason: 'team_refused' })
      const run = (await created.json()) as { id: string; name: string }
      return reply(200, { accepted: true, workstream: id, flowRun: run.id, ...(options.ui ? { url: `${options.ui}/runs/flow-run/${run.id}` } : {}) })
    } catch {
      return reply(502, { reason: 'teams_unreachable' })
    }
  }
}

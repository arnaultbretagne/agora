// Broker owner API (S7): the same owner-request protocol gate as runtime-control (packages/
// owner-requests, findings §P5), for attach_grant/detach_grant. The Agent for the incarnation is
// ensured (create-or-discover, never rebind) before either verb acts on it — BUILD's Broker part
// (Step 6) is expected to have already done this, but a GRANT retry after a crash between BUILD
// and GRANT must not fail just because it re-derives the same Agent.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { toWireGrantSet, type Authorization } from '@agora/domain'
import type { OwnerGate } from '@agora/owner-requests'
import type { OwnerRequest, OwnerResponse } from '@agora/owner-requests'
import { compile, type CapabilityCatalogue, type CredentialResolver } from '@agora/policy'
import { agentIdentifierFor, ensureAgent, retireAgent } from './agents.js'
import { attachDesiredGrants, revokeExcessGrants } from './grants.js'
import { readConsistentInventory } from './inventory.js'
import type { OneCliClient } from './onecli/client.js'
import type { PrivateStore } from './private-store.js'

export interface BrokerApiOptions {
  readonly client: OneCliClient
  readonly gate: OwnerGate
  /** The reviewed capability catalogue, and the live resolver turning its stable refs into this project's actual OneCLI ids — refreshed before every compile so a newly configured credential is visible without a restart. */
  readonly catalogue: CapabilityCatalogue
  readonly resolver: CredentialResolver & { refresh(): Promise<void> }
  /** REVOKE closes the relay before narrowing/detaching authority (003 verbs) — optional only for tests that never open a tunnel. */
  readonly tunnels?: { terminateAll(incarnation: string): number }
  /** Where the relay reads the Agent's gateway bearer from — optional only for tests that never exercise the relay. */
  readonly privateStore?: PrivateStore
}

function problem(res: ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, { 'content-type': 'application/problem+json' })
  res.end(JSON.stringify({ type: 'about:blank', title, status, detail }))
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createBrokerApi(options: BrokerApiOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter((p) => p.length > 0)

      if (parts[0] === 'v1' && parts[1] === 'incarnations' && parts.length === 3 && req.method === 'GET') {
        const incarnation = parts[2]!
        const agent = await ensureAgent(options.client, incarnation)
        const inventory = await readConsistentInventory(options.client, agent.id)
        if (inventory === undefined) return problem(res, 503, 'Inconsistent read', 'attached/effective did not settle to a consistent pair within budget')
        return send(res, 200, { agentId: agent.id, attached: toWireGrantSet(inventory.attached), effective: toWireGrantSet(inventory.effective) })
      }

      if (parts[0] === 'v1' && parts[1] === 'owner-requests' && req.method === 'POST') {
        return handleOwnerRequest(options, res, (await body(req)) as OwnerRequest)
      }

      return problem(res, 404, 'Not found', `no resource at ${url.pathname}`)
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) problem(res, 500, 'Internal error', detail)
      else res.destroy()
    })
  })
}

async function handleOwnerRequest(options: BrokerApiOptions, res: ServerResponse, request: OwnerRequest): Promise<void> {
  if (typeof request.operation !== 'string' || typeof request.attemptKey !== 'string' || request.target === undefined) {
    return problem(res, 422, 'Invalid owner request', 'operation, attempt_key and target are required')
  }

  const decision = await options.gate.decide(request)
  if (decision.kind === 'respond') return send(res, 200, decision.response)

  let response: OwnerResponse
  switch (request.operation) {
    case 'attach_grant':
      response = await attachGrant(options, request)
      break
    case 'detach_grant':
      response = await detachGrant(options, request)
      break
    case 'cleanup_agent':
      response = await cleanupAgent(options, request)
      break
    default:
      return problem(res, 422, 'Unknown operation', `operation "${request.operation}" is not a broker operation`)
  }

  await options.gate.record(request, response)
  return send(res, 200, response)
}

/**
 * Compilation happens here, not at the caller (001 Intent — "the exact desired grant set compiled
 * for one policy revision" is the verb's input, but only the Broker has live secret/connection
 * ids to resolve against; refreshing the resolver right before compiling means a credential an
 * operator just configured in OneCLI is visible without restarting this process).
 */
async function compileDesired(options: BrokerApiOptions, request: OwnerRequest): Promise<{ kind: 'compiled'; grants: ReadonlySet<Authorization> } | OwnerResponse> {
  const capabilityIds = (request.payload as { capabilityIds?: unknown }).capabilityIds
  if (!Array.isArray(capabilityIds) || !capabilityIds.every((id) => typeof id === 'string')) {
    return { kind: 'unknown', detail: 'payload.capabilityIds must be the Intent\'s requested capability id list' }
  }
  await options.resolver.refresh()
  const result = compile(capabilityIds, options.catalogue, options.resolver)
  if (result.kind === 'denied') return { kind: 'unknown', detail: `${result.reason}: ${result.detail}` }
  return { kind: 'compiled', grants: result.grants }
}

async function attachGrant(options: BrokerApiOptions, request: OwnerRequest): Promise<OwnerResponse> {
  const compiled = await compileDesired(options, request)
  if (compiled.kind !== 'compiled') return compiled
  const agent = await ensureAgent(options.client, request.target.id)
  await storeBearerFor(options, request.target.id, agent.id)
  const inventory = await readConsistentInventory(options.client, agent.id)
  if (inventory === undefined) return { kind: 'unknown', detail: 'attached/effective did not settle to a consistent pair' }
  await attachDesiredGrants(options.client, agent.id, compiled.grants)
  return { kind: 'completed', result: { agentId: agent.id } }
}

/** The Agent's gateway bearer never reaches the Pod (ADR 0009) — captured once here, from the trusted Broker, into the encrypted private store the relay reads from. */
async function storeBearerFor(options: BrokerApiOptions, incarnation: string, agentId: string): Promise<void> {
  if (options.privateStore === undefined) return
  if (options.privateStore.get(incarnation) !== undefined) return // already captured — never re-read a token unnecessarily
  const identifier = agentIdentifierFor(incarnation)
  const agents = await options.client.listAgents()
  const bearer = agents.find((a) => a.id === agentId && a.identifier === identifier)?.accessToken
  if (bearer !== undefined) options.privateStore.put(incarnation, bearer)
}

async function detachGrant(options: BrokerApiOptions, request: OwnerRequest): Promise<OwnerResponse> {
  const compiled = await compileDesired(options, request)
  if (compiled.kind !== 'compiled') return compiled
  // The relay closes to affected traffic before authority narrows (003 verbs REVOKE) — never after.
  options.tunnels?.terminateAll(request.target.id)
  const agent = await ensureAgent(options.client, request.target.id)
  await revokeExcessGrants(options.client, agent.id, compiled.grants)
  return { kind: 'completed', result: { agentId: agent.id } }
}

async function cleanupAgent(options: BrokerApiOptions, request: OwnerRequest): Promise<OwnerResponse> {
  options.tunnels?.terminateAll(request.target.id)
  await retireAgent(options.client, request.target.id)
  options.privateStore?.delete(request.target.id)
  await options.gate.retire(request.workstreamId, request.target.id)
  return { kind: 'completed', result: { retired: request.target.id } }
}

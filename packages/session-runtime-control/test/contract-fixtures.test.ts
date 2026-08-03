import assert from 'node:assert/strict'
import { test } from 'node:test'
import SwaggerParser from '@apidevtools/swagger-parser'
import { Ajv } from 'ajv'
import { SENSITIVE_SESSION_RUNTIME_CONTROL_FIELDS } from '../src/types.js'

const SESSION_RUNTIME_CONTROL_PATH = new URL(
  '../../../../contracts/openapi/session-runtime-control.yaml',
  import.meta.url,
).pathname
const BROKER_CONTROL_PATH = new URL('../../../../contracts/openapi/broker-control.yaml', import.meta.url).pathname

// additionalProperties/required-field checks only; format validation is not exercised here, so
// ajv-formats is not needed (its "format: uuid" etc. keywords would simply be inert without it).
function ajv() {
  return new Ajv({ allErrors: true, strict: false })
}

function requireSchema(schemas: Record<string, object>, name: string): object {
  const schema = schemas[name]
  if (!schema) throw new Error(`missing schema ${name}`)
  return schema
}

test('the Session Runtime control OpenAPI document is valid', async () => {
  const api = (await SwaggerParser.validate(SESSION_RUNTIME_CONTROL_PATH)) as unknown as {
    components?: { schemas?: unknown }
  }
  assert.ok(api.components?.schemas)
})

test('required: a materialize request cannot carry an aoc_ bearer, OneCLI control key or provider token', async () => {
  const api = (await SwaggerParser.dereference(SESSION_RUNTIME_CONTROL_PATH)) as unknown as {
    components: { schemas: Record<string, object> }
  }
  const validate = ajv().compile(requireSchema(api.components.schemas, 'MaterializeSessionRuntimeRequest'))
  const valid = {
    agentId: 'claude-code',
    runtimeDefinitionVersion: 'v3',
    workspaceMountRef: 'pvc-1',
    executionGrantRef: 'grant-ref-opaque',
  }
  assert.equal(validate(valid), true, JSON.stringify(validate.errors))

  for (const poison of [
    { oneCliAgentId: 'agent-123' },
    { oneCliControlKey: 'ctrl_live_abcdef' },
    { providerToken: 'sk-live-abcdef' },
    { upstreamBearer: 'aoc_live_abcdef' },
  ]) {
    assert.equal(validate({ ...valid, ...poison }), false, `${JSON.stringify(poison)} must be rejected`)
  }
})

test('required: a Session Runtime status cannot carry an aoc_ bearer, OneCLI control key or provider token', async () => {
  const api = (await SwaggerParser.dereference(SESSION_RUNTIME_CONTROL_PATH)) as unknown as {
    components: { schemas: Record<string, object> }
  }
  const validate = ajv().compile(requireSchema(api.components.schemas, 'SessionRuntimeStatus'))
  const valid = { sessionId: '11111111-1111-1111-1111-111111111111', agentId: 'claude-code', runtimeDefinitionVersion: 'v3', state: 'ready' }
  assert.equal(validate(valid), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...valid, oneCliAgentId: 'aoc_live_x' }), false)
  assert.equal(validate({ ...valid, runtimeId: 'r-1' }), false)
})

test('required: a Broker grant/activation cannot carry an aoc_ bearer, OneCLI control key or provider token', async () => {
  const api = (await SwaggerParser.dereference(BROKER_CONTROL_PATH)) as unknown as {
    components: { schemas: Record<string, object> }
  }
  const grant = ajv().compile(requireSchema(api.components.schemas, 'IssuedGrant'))
  const validGrant = {
    grantId: '11111111-1111-1111-1111-111111111111',
    grantRef: 'opaque-ref',
    sessionId: '11111111-1111-1111-1111-111111111111',
    agentId: 'claude-code',
    policyVersion: 'v1',
    capabilityDigest: 'a'.repeat(64),
    capabilities: [],
    mcpServers: [],
    expiresAt: '2026-08-03T00:00:00Z',
  }
  assert.equal(grant(validGrant), true, JSON.stringify(grant.errors))
  assert.equal(grant({ ...validGrant, providerToken: 'sk-live-x' }), false)

  const activation = ajv().compile(requireSchema(api.components.schemas, 'GrantActivation'))
  const validActivation = {
    activationId: '11111111-1111-1111-1111-111111111111',
    grantId: '11111111-1111-1111-1111-111111111111',
    sessionId: '11111111-1111-1111-1111-111111111111',
    agentId: 'claude-code',
    workloadIdentity: 'workload-1',
    expiresAt: '2026-08-03T00:00:00Z',
  }
  assert.equal(activation(validActivation), true, JSON.stringify(activation.errors))
  assert.equal(activation({ ...validActivation, oneCliControlKey: 'ctrl_x' }), false)
})

test('our SENSITIVE_SESSION_RUNTIME_CONTROL_FIELDS set matches the spec writeOnly/readOnly + x-sensitive fields', async () => {
  const api = (await SwaggerParser.dereference(SESSION_RUNTIME_CONTROL_PATH)) as unknown as {
    components: { schemas: Record<string, Record<string, unknown>> }
  }
  const sensitiveInSpec = new Set<string>()
  for (const schema of Object.values(api.components.schemas)) {
    const properties = (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {}
    for (const [name, definition] of Object.entries(properties)) {
      if ((definition.writeOnly || definition.readOnly) && definition['x-sensitive']) sensitiveInSpec.add(name)
    }
  }
  assert.deepEqual(sensitiveInSpec, SENSITIVE_SESSION_RUNTIME_CONTROL_FIELDS)
})

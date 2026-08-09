import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EQUIPMENT_CATALOGUE_VERSION } from '../src/catalogue.js'
import { PolicyDenialError, resolveEquipmentPolicy } from '../src/resolve.js'

function context(overrides: Partial<Parameters<typeof resolveEquipmentPolicy>[1]> = {}) {
  return {
    principalId: 'alice',
    workstreamCategory: 'discussion' as const,
    agentId: 'fake-agent',
    runtimeDefinitionVersion: 'v1',
    ...overrides,
  }
}

test('required: unknown resource is denied before any OneCLI mutation could happen (pure function, no side effects)', () => {
  assert.throws(
    () =>
      resolveEquipmentPolicy({ catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'nonexistent', access: 'read' }] }, context()),
    (error: unknown) => error instanceof PolicyDenialError && error.code === 'unknown_resource_or_access',
  )
})

test('required: unknown access level for a real resource is denied', () => {
  assert.throws(
    () => resolveEquipmentPolicy({ catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'delete-everything' }] }, context()),
    (error: unknown) => error instanceof PolicyDenialError && error.code === 'unknown_resource_or_access',
  )
})

test('required: a contradictory/duplicate resource entry is denied, not "last value wins"', () => {
  assert.throws(
    () =>
      resolveEquipmentPolicy(
        {
          catalogueVersion: EQUIPMENT_CATALOGUE_VERSION,
          resources: [
            { resource: 'vault', access: 'read' },
            { resource: 'vault', access: 'read-write' },
          ],
        },
        context(),
      ),
    (error: unknown) => error instanceof PolicyDenialError && error.code === 'duplicate_resource',
  )
})

test('an unknown catalogue version is denied', () => {
  assert.throws(
    () => resolveEquipmentPolicy({ catalogueVersion: 'some-old-version', resources: [] }, context()),
    (error: unknown) => error instanceof PolicyDenialError && error.code === 'catalogue_version_unknown',
  )
})

test('required: an operator rule (invocation category cannot request write-capable equipment) is enforced', () => {
  assert.throws(
    () =>
      resolveEquipmentPolicy(
        { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read-write' }] },
        context({ workstreamCategory: 'invocation' }),
      ),
    (error: unknown) => error instanceof PolicyDenialError && error.code === 'invocation_write_access_denied',
  )
  // The SAME request succeeds for a 'discussion' Workstream.
  const resolved = resolveEquipmentPolicy(
    { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read-write' }] },
    context({ workstreamCategory: 'discussion' }),
  )
  assert.equal(resolved.capabilities.length, 1)
})

test('required: request combinations resolve to independent capability facts, never a named profile', () => {
  const resolved = resolveEquipmentPolicy(
    {
      catalogueVersion: EQUIPMENT_CATALOGUE_VERSION,
      resources: [
        { resource: 'vault', access: 'read' },
        { resource: 'github', access: 'read' },
      ],
    },
    context(),
  )
  assert.equal(resolved.capabilities.length, 2)
  for (const fact of resolved.capabilities) {
    assert.ok(!('profile' in fact), 'a capability fact never carries a profile name')
  }
  assert.ok(resolved.capabilities.some((c) => c.capabilityId === 'vault' && c.accessLevel === 'read'))
  assert.ok(resolved.capabilities.some((c) => c.capabilityId === 'github' && c.accessLevel === 'read'))
})

test('required: the capability digest is deterministic for the same inputs and changes when inputs change', () => {
  const request = { catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read' as const }] }
  const a = resolveEquipmentPolicy(request, context())
  const b = resolveEquipmentPolicy(request, context())
  assert.equal(a.capabilityDigest, b.capabilityDigest)
  assert.match(a.capabilityDigest, /^[a-f0-9]{64}$/)

  // A different principal requesting the exact same facts gets the SAME digest — the digest
  // represents resolved capability facts, not "who asked".
  const c = resolveEquipmentPolicy(request, context({ principalId: 'bob' }))
  assert.equal(a.capabilityDigest, c.capabilityDigest)

  // A different Agent changes the digest.
  const d = resolveEquipmentPolicy(request, context({ agentId: 'fake-agent-b' }))
  assert.notEqual(a.capabilityDigest, d.capabilityDigest)
})

test('capability order in the request never changes the resolved facts or digest (sorted deterministically)', () => {
  const a = resolveEquipmentPolicy(
    {
      catalogueVersion: EQUIPMENT_CATALOGUE_VERSION,
      resources: [
        { resource: 'vault', access: 'read' },
        { resource: 'github', access: 'read' },
      ],
    },
    context(),
  )
  const b = resolveEquipmentPolicy(
    {
      catalogueVersion: EQUIPMENT_CATALOGUE_VERSION,
      resources: [
        { resource: 'github', access: 'read' },
        { resource: 'vault', access: 'read' },
      ],
    },
    context(),
  )
  assert.equal(a.capabilityDigest, b.capabilityDigest)
})

test('required: resolved mcpServers contain no provider secret and no execution-grant/relay/OneCLI token', () => {
  const resolved = resolveEquipmentPolicy({ catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [{ resource: 'vault', access: 'read' }] }, context())
  assert.equal(resolved.mcpServers.length, 1)
  const server = resolved.mcpServers[0]!
  assert.equal(server.headers.length, 0)
  const serialized = JSON.stringify(server)
  assert.doesNotMatch(serialized, /token|bearer|secret|grant/i)
})

test('an empty equipment request resolves to zero capabilities and a stable digest', () => {
  const resolved = resolveEquipmentPolicy({ catalogueVersion: EQUIPMENT_CATALOGUE_VERSION, resources: [] }, context())
  assert.equal(resolved.capabilities.length, 0)
  assert.match(resolved.capabilityDigest, /^[a-f0-9]{64}$/)
})

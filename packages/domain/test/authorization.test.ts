import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Authorization, GrantComparisonContext } from '../src/index.js'
import { authorizationKey, equals, excess, fromWireGrantSet, grantUnion, includes, isSubset, toWireGrantSet } from '../src/index.js'

interface AuthOverrides {
  kind?: Authorization['kind']
  credential?: string
  tools?: Authorization['tools']
  approval?: Authorization['approval']
  restrictions?: Authorization['restrictions']
  opaque?: Record<string, unknown>
}

function auth(overrides: AuthOverrides = {}): Authorization {
  const authorization: Authorization = {
    kind: overrides.kind ?? 'secret',
    credential: overrides.credential ?? 'cred-a',
    tools: overrides.tools ?? new Set(['tool-1']),
    approval: overrides.approval ?? 'unconditional',
    restrictions: overrides.restrictions ?? [],
  }
  if (overrides.opaque !== undefined) {
    return { ...authorization, opaque: overrides.opaque }
  }
  return authorization
}

const noContext: GrantComparisonContext = {}

test('AUTH-001 a remaining grant of a reduced two-grant capability is excess with its removable identity', () => {
  const first = auth({ credential: 'cred-a' })
  const second = auth({ credential: 'cred-b', tools: new Set(['tool-2']) })
  const observed = new Set([first, second])
  const reducedDesired = new Set([first])
  const removable = excess(observed, reducedDesired)
  assert.deepEqual(removable, [second])
  assert.equal(authorizationKey(removable[0]!), 'secret:cred-b')
})

test('AUTH-003 an attachment masked by an organization restriction is still attached authority', () => {
  const masked = auth({ restrictions: [{ kind: 'organization-mask', value: { reason: 'policy' } }] })
  const observed = new Set([masked])
  assert.deepEqual(excess(observed, new Set()), [masked])
  assert.equal(isSubset(observed, new Set()), false)
})

test('AUTH-007 an approval mode change breaks equality', () => {
  const unconditional = auth({ approval: 'unconditional' })
  const approvalRequired = auth({ approval: 'required' })
  assert.equal(equals(new Set([approvalRequired]), new Set([unconditional])), false)
  assert.equal(includes(unconditional, approvalRequired), true)
  assert.equal(includes(approvalRequired, unconditional), false)
  assert.deepEqual(excess(new Set([approvalRequired]), new Set([unconditional])), [])
})

test('approval-required execution is a subset of unconditional execution of the same tool', () => {
  assert.equal(includes(auth({ approval: 'unconditional' }), auth({ approval: 'required' })), true)
  assert.equal(includes(auth({ approval: 'required' }), auth({ approval: 'unconditional' })), false)
  assert.equal(includes(auth({ approval: 'required' }), auth({ approval: 'required' })), true)
})

test('a narrower resource restriction is a subset of the broader scope when the pinned mapping proves it', () => {
  const desired = auth({ restrictions: [{ kind: 'path-prefix', value: { prefix: '/tmp' } }] })
  const observed = auth({ restrictions: [{ kind: 'path-prefix', value: { prefix: '/tmp/workspace' } }] })
  const mapping: GrantComparisonContext = {
    provesInclusion: (narrower, broader) => {
      const narrowValue = narrower.value as { prefix: string }
      const broadValue = broader.value as { prefix: string }
      return narrowValue.prefix.startsWith(broadValue.prefix)
    },
  }
  assert.equal(includes(desired, observed, mapping), true)
  assert.deepEqual(excess(new Set([observed]), new Set([desired]), mapping), [])
  assert.equal(includes(desired, observed), false)
  assert.deepEqual(excess(new Set([observed]), new Set([desired])), [observed])
})

test('an unrestricted grant is never provably narrower than a restricted one', () => {
  const desired = auth({ restrictions: [{ kind: 'path-prefix', value: { prefix: '/tmp' } }] })
  const observed = auth()
  assert.equal(includes(desired, observed), false)
  assert.deepEqual(excess(new Set([observed]), new Set([desired])), [observed])
})

test('restrictions of different kinds are not provably comparable', () => {
  const broader = auth({ restrictions: [{ kind: 'path-prefix', value: { prefix: '/tmp' } }] })
  const narrower = auth({ restrictions: [{ kind: 'ip-range', value: { prefix: '/tmp' } }] })
  assert.equal(includes(broader, narrower), false)
})

test('a full-access grant never compares equal to a finite reviewed subset without a catalogue', () => {
  const finite = auth({ tools: new Set(['tool-1', 'tool-2']) })
  const full = auth({ tools: 'full' })
  assert.equal(equals(new Set([full]), new Set([finite])), false)
  assert.deepEqual(excess(new Set([full]), new Set([finite])), [full])
  assert.equal(includes(full, finite), true)
  assert.equal(includes(finite, full), false)
})

test('a full-access grant expands only against a supplied complete tool catalogue', () => {
  const finite = auth({ tools: new Set(['tool-1', 'tool-2']) })
  const full = auth({ tools: 'full' })
  const completeCatalogue = new Set(['tool-1', 'tool-2'])
  assert.equal(equals(new Set([full]), new Set([finite]), { toolCatalogue: completeCatalogue }), true)
  const largerCatalogue = new Set(['tool-1', 'tool-2', 'tool-3'])
  assert.equal(equals(new Set([full]), new Set([finite]), { toolCatalogue: largerCatalogue }), false)
  assert.deepEqual(excess(new Set([full]), new Set([finite]), { toolCatalogue: largerCatalogue }), [full])
})

test('unknown fields keep the entry distinguishable and prevent equality', () => {
  const plain = auth()
  const withUnknownField = auth({ opaque: { upstream: 'entry-7' } })
  const sameUnknownField = auth({ opaque: { upstream: 'entry-7' } })
  assert.equal(equals(new Set([withUnknownField]), new Set([plain])), false)
  assert.deepEqual(excess(new Set([withUnknownField]), new Set([plain])), [withUnknownField])
  assert.equal(equals(new Set([withUnknownField]), new Set([sameUnknownField])), true)
})

test('credential and grant kind identity participate in every comparison', () => {
  const otherCredential = auth({ credential: 'cred-b' })
  const connectionKind = auth({ kind: 'connection' })
  const reference = auth()
  assert.equal(includes(reference, otherCredential), false)
  assert.equal(includes(reference, connectionKind), false)
  assert.equal(equals(new Set([reference]), new Set([otherCredential])), false)
  assert.equal(equals(new Set([reference]), new Set([connectionKind])), false)
})

test('tool sets compare as individual authorizations', () => {
  const desired = auth({ tools: new Set(['tool-1', 'tool-2']) })
  assert.equal(includes(desired, auth({ tools: new Set(['tool-1']) })), true)
  assert.equal(includes(desired, auth({ tools: new Set(['tool-1', 'tool-3']) })), false)
  assert.equal(equals(new Set([desired]), new Set([auth({ tools: new Set(['tool-2', 'tool-1']) })])), true)
})

test('set operations pair entries by provable inclusion, not by canonical key alone', () => {
  const desired = new Set([auth({ tools: new Set(['tool-1', 'tool-2']) })])
  const observedNarrow = new Set([auth({ tools: new Set(['tool-1']) })])
  assert.equal(isSubset(observedNarrow, desired), true)
  assert.equal(isSubset(desired, observedNarrow), false)
  assert.equal(equals(observedNarrow, desired), false)
  assert.deepEqual(excess(observedNarrow, desired), [])
  const observedOther = new Set([auth({ credential: 'cred-z' })])
  assert.deepEqual(excess(observedOther, desired), [...observedOther])
})

test('grantUnion merges attached and effective entries for comparison', () => {
  const attached = new Set([auth({ credential: 'cred-a' })])
  const effective = new Set([auth({ credential: 'cred-b' })])
  const union = grantUnion(attached, effective)
  assert.equal(union.size, 2)
  const desired = new Set([auth({ credential: 'cred-a' })])
  assert.equal(isSubset(union, desired), false)
  assert.deepEqual(excess(union, desired), [...effective])
})

test('a grant set round-trips through the wire form exactly (JSON has no Set)', () => {
  const grants = new Set([auth({ credential: 'cred-a', tools: new Set(['b', 'a']) }), auth({ credential: 'cred-b', tools: 'full' })])
  const wire = toWireGrantSet(grants)
  const json = JSON.parse(JSON.stringify(wire)) as typeof wire
  assert.deepEqual(json[0]!.tools, ['a', 'b'], 'tools travel sorted, not in Set iteration order')
  const restored = fromWireGrantSet(json)
  assert.equal(equals(restored, grants), true)
})

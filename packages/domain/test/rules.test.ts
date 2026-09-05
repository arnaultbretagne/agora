import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Authorization, ConstructionObservation, Intent, ObservationFieldName, RuleFieldReader, RuleId, RuleResolution, RuleTable } from '../src/index.js'
import { ORDERED_RULES, capabilityId, construction, harnessId } from '../src/index.js'

interface AuthOverrides {
  kind?: Authorization['kind']
  credential?: string
  tools?: Authorization['tools']
  approval?: Authorization['approval']
}

function auth(overrides: AuthOverrides = {}): Authorization {
  return {
    kind: overrides.kind ?? 'secret',
    credential: overrides.credential ?? 'cred-a',
    tools: overrides.tools ?? new Set(['tool-1']),
    approval: overrides.approval ?? 'unconditional',
    restrictions: [],
  }
}

function table(file: string): RuleTable {
  const found = ORDERED_RULES.find((candidate) => candidate.file === file)
  assert.ok(found, `table ${file} must exist in ORDERED_RULES`)
  return found
}

const baseIntent: Intent = {
  power: 'on',
  harness: harnessId('claude-code'),
  capabilities: new Set([capabilityId('workspace.read')]),
  model: 'model-a',
  effort: 'default',
  persona: 'default',
}

function intentWith(overrides: Partial<Intent>): Intent {
  return { ...baseIntent, ...overrides }
}

function readerFor(
  values: Partial<Record<ObservationFieldName, unknown>>,
  intent: Intent,
  resolve: RuleResolution = { harnessDigest: () => 'digest-a', capabilityGrants: () => new Set<Authorization>() },
): RuleFieldReader {
  return {
    intent,
    resolve,
    observation: (field) => {
      if (!Object.prototype.hasOwnProperty.call(values, field)) {
        throw new Error(`enumeration did not provide ${field}`)
      }
      return values[field] as never
    },
  }
}

function matchingRows(currentTable: RuleTable, input: RuleFieldReader): RuleId[] {
  return currentTable.rows.filter((row) => row.when(input)).map((row) => row.id)
}

function assertExactlyOne(currentTable: RuleTable, input: RuleFieldReader, expected: RuleId): void {
  const matched = matchingRows(currentTable, input)
  assert.deepEqual(matched, [expected], `expected exactly [${expected}], got [${matched.join(', ')}]`)
}

function idsOf(file: string): RuleId[] {
  return table(file).rows.map((row) => row.id)
}

test('each table keeps the exact ordered rule ids of its specification', () => {
  assert.deepEqual(idsOf('004_power'), ['POWER-001', 'POWER-002', 'POWER-003'])
  assert.deepEqual(idsOf('005_construction'), ['CONSTRUCT-001', 'CONSTRUCT-002', 'CONSTRUCT-003'])
  assert.deepEqual(idsOf('006_capabilities'), ['CAPS-001', 'CAPS-002', 'CAPS-004', 'CAPS-003'])
  assert.deepEqual(idsOf('007_session'), ['SESSION-005', 'SESSION-001', 'SESSION-002', 'SESSION-003', 'SESSION-004'])
  assert.deepEqual(idsOf('008_config'), ['CONFIG-001', 'CONFIG-002', 'CONFIG-003'])
  assert.deepEqual(idsOf('009_sync'), ['SYNC-001', 'SYNC-002'])
  assert.deepEqual(idsOf('010_converge'), ['CONVERGE-001'])
})

test('ORDERED_RULES walks the seven tables by ascending file prefix', () => {
  assert.deepEqual(
    ORDERED_RULES.map((entry) => entry.file),
    ['004_power', '005_construction', '006_capabilities', '007_session', '008_config', '009_sync', '010_converge'],
  )
})

test('POWER partitions the four combinations of intent.power and observation.power', () => {
  const power = table('004_power')
  let combinations = 0
  for (const intentPower of ['on', 'off'] as const) {
    for (const observedPower of ['on', 'off'] as const) {
      const input = readerFor({ 'observation.power': observedPower }, intentWith({ power: intentPower }))
      assertExactlyOne(power, input, intentPower === 'on' ? 'POWER-003' : observedPower === 'off' ? 'POWER-001' : 'POWER-002')
      combinations += 1
    }
  }
  assert.equal(combinations, 4)
})

function buildConstruction(list: readonly ({ digest: string } | { incoherent: true })[]): ConstructionObservation {
  return construction(list)
}

function isValueEmpty(value: ConstructionObservation): boolean {
  return value.kind === 'empty'
}

function isValueExactly(value: ConstructionObservation, digest: string): boolean {
  return value.kind === 'set' && !value.incoherent && value.digests.size === 1 && value.digests.has(digest)
}

test('CONSTRUCTION partitions the empty, exact and incoherent construction values for each pinned digest', () => {
  const constructionTable = table('005_construction')
  const alphabet = ['digest-a', 'digest-b']
  const singleMembers: ({ digest: string } | { incoherent: true })[] = [
    { digest: 'digest-a' },
    { digest: 'digest-b' },
    { incoherent: true },
  ]
  const memberLists: (readonly ({ digest: string } | { incoherent: true })[])[] = [[]]
  for (const first of singleMembers) memberLists.push([first])
  for (const first of singleMembers) {
    for (const second of singleMembers) memberLists.push([first, second])
  }

  const distinctValues: ConstructionObservation[] = []
  const seen = new Set<string>()
  for (const list of memberLists) {
    const value = buildConstruction(list)
    const key = value.kind === 'empty' ? 'empty' : `set|[${[...value.digests].sort().join(',')}]|${String(value.incoherent)}`
    if (!seen.has(key)) {
      seen.add(key)
      distinctValues.push(value)
    }
  }
  assert.equal(distinctValues.length, 7)

  let combinations = 0
  for (const pinned of alphabet) {
    const resolve: RuleResolution = { harnessDigest: () => pinned, capabilityGrants: () => new Set<Authorization>() }
    for (const value of distinctValues) {
      const input = readerFor({ 'observation.construction': value }, baseIntent, resolve)
      const expected = isValueEmpty(value) ? 'CONSTRUCT-001' : isValueExactly(value, pinned) ? 'CONSTRUCT-003' : 'CONSTRUCT-002'
      assertExactlyOne(constructionTable, input, expected)
      combinations += 1
    }
  }
  assert.equal(combinations, 14)
})

test('CAPABILITIES partitions the (desired, attached, effective) grant-set space with CAPS-004 before CAPS-003', () => {
  const capabilities = table('006_capabilities')
  const a1 = auth({ credential: 'cred-a' })
  const a2 = auth({ credential: 'cred-b' })
  const a1Required = auth({ credential: 'cred-a', approval: 'required' })
  const a1Full = auth({ credential: 'cred-a', tools: 'full' })
  const observedUniverse = [a1, a2, a1Required, a1Full]
  const desiredUniverse = [a1, a2]

  function subsetsOf<T>(items: readonly T[]): ReadonlySet<ReadonlySet<T>> {
    const result = new Set<ReadonlySet<T>>()
    for (let mask = 0; mask < 1 << items.length; mask += 1) {
      const subset = new Set<T>()
      items.forEach((item, index) => {
        if (mask & (1 << index)) subset.add(item)
      })
      result.add(subset)
    }
    return result
  }

  const desiredSets = [...subsetsOf(desiredUniverse)]
  const observedSets = [...subsetsOf(observedUniverse)]
  let combinations = 0
  for (const desired of desiredSets) {
    const resolve: RuleResolution = { harnessDigest: () => 'digest-a', capabilityGrants: () => desired }
    for (const attached of observedSets) {
      for (const effective of observedSets) {
        const input = readerFor(
          { 'observation.grants.attached': attached, 'observation.grants.effective': effective },
          intentWith({ capabilities: new Set([capabilityId('workspace.read')]) }),
          resolve,
        )
        const matched = matchingRows(capabilities, input)
        assert.equal(matched.length, 1, `exactly one CAPS row must match, got [${matched.join(', ')}]`)
        combinations += 1
      }
    }
  }
  assert.equal(combinations, 1024)
})

test('CAPABILITIES selects the documented row for its four representative cases', () => {
  const capabilities = table('006_capabilities')
  const a1 = auth({ credential: 'cred-a' })
  const a2 = auth({ credential: 'cred-b' })
  const resolveFor = (desired: ReadonlySet<Authorization>): RuleResolution => ({
    harnessDigest: () => 'digest-a',
    capabilityGrants: () => desired,
  })
  const intent = intentWith({ capabilities: new Set([capabilityId('workspace.read')]) })

  const excessCase = readerFor(
    { 'observation.grants.attached': new Set([a1, a2]), 'observation.grants.effective': new Set([a1]) },
    intent,
    resolveFor(new Set([a1])),
  )
  assert.deepEqual(matchingRows(capabilities, excessCase), ['CAPS-001'])

  const missingCase = readerFor(
    { 'observation.grants.attached': new Set([a1]), 'observation.grants.effective': new Set([a1]) },
    intent,
    resolveFor(new Set([a1, a2])),
  )
  assert.deepEqual(matchingRows(capabilities, missingCase), ['CAPS-002'])

  const pendingEffectiveness = readerFor(
    { 'observation.grants.attached': new Set([a1]), 'observation.grants.effective': new Set() },
    intent,
    resolveFor(new Set([a1])),
  )
  assert.deepEqual(matchingRows(capabilities, pendingEffectiveness), ['CAPS-004'])

  const converged = readerFor(
    { 'observation.grants.attached': new Set([a1]), 'observation.grants.effective': new Set([a1]) },
    intent,
    resolveFor(new Set([a1])),
  )
  assert.deepEqual(matchingRows(capabilities, converged), ['CAPS-003'])
})

test('SESSION partitions the session values, consulting the anchor only for openable', () => {
  const session = table('007_session')
  let combinations = 0
  for (const sessionValue of ['pending', 'openable', 'live', 'unusable'] as const) {
    for (const anchorValue of ['compatible', 'none'] as const) {
      const input = readerFor(
        { 'observation.session': sessionValue, 'observation.anchor': anchorValue },
        baseIntent,
      )
      const expected: RuleId =
        sessionValue === 'unusable'
          ? 'SESSION-005'
          : sessionValue === 'pending'
            ? 'SESSION-001'
            : sessionValue === 'openable'
              ? anchorValue === 'compatible'
                ? 'SESSION-002'
                : 'SESSION-003'
              : 'SESSION-004'
      assertExactlyOne(session, input, expected)
      combinations += 1
    }
  }
  assert.equal(combinations, 8)
})

test('SESSION rows that do not need the anchor never read it', () => {
  const session = table('007_session')
  for (const row of session.rows) {
    if (row.id === 'SESSION-002' || row.id === 'SESSION-003') continue
    const input = readerFor({ 'observation.session': 'live' }, baseIntent)
    assert.equal(row.when(input), row.id === 'SESSION-004')
  }
})

test('CONFIG partitions model and effort equality in model-before-effort order', () => {
  const config = table('008_config')
  let combinations = 0
  for (const modelMatches of [true, false]) {
    for (const effortMatches of [true, false]) {
      const input = readerFor(
        {
          'observation.model': modelMatches ? 'model-a' : 'model-b',
          'observation.effort': effortMatches ? 'default' : 'high',
        },
        intentWith({ model: 'model-a', effort: 'default' }),
      )
      const expected = !modelMatches ? 'CONFIG-001' : !effortMatches ? 'CONFIG-002' : 'CONFIG-003'
      assertExactlyOne(config, input, expected)
      combinations += 1
    }
  }
  assert.equal(combinations, 4)
  const order = idsOf('008_config')
  assert.equal(order.indexOf('CONFIG-001') < order.indexOf('CONFIG-002'), true)
})

test('SYNC partitions its two registered values', () => {
  const sync = table('009_sync')
  let combinations = 0
  for (const syncValue of ['current', 'stale'] as const) {
    const input = readerFor({ 'observation.sync': syncValue }, baseIntent)
    assertExactlyOne(sync, input, syncValue === 'stale' ? 'SYNC-001' : 'SYNC-002')
    combinations += 1
  }
  assert.equal(combinations, 2)
})

test('CONVERGE matches unconditionally with its single terminal row', () => {
  const converge = table('010_converge')
  assertExactlyOne(converge, readerFor({}, baseIntent), 'CONVERGE-001')
})

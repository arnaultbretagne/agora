import assert from 'node:assert/strict'
import { test } from 'node:test'
import { construction, harnessId, type Acquired, type Intent, type ObservationFieldName, type ObservationReader, type RuleResolution } from '@agora/domain'
import type { ObservationSource } from '@agora/engine'
import { checkAdmission } from '../src/admission.js'

function ok<T>(value: T): Acquired<T> {
  return { ok: true, value }
}

const RESOLVE: RuleResolution = {
  harnessDigest: () => 'sha256:abc',
  capabilityGrants: () => new Set(),
}

function baseIntent(overrides: Partial<Intent> = {}): Intent {
  return { power: 'on', harness: harnessId('claude-code'), capabilities: new Set(), model: 'sonnet', effort: 'high', persona: 'default', ...overrides }
}

/** A reader that reports a fully realized "on" Intent all the way to CONVERGE-001. */
function convergedSource(): ObservationSource {
  const reader: ObservationReader = {
    power: () => ok('on'),
    construction: () => ok(construction([{ digest: 'sha256:abc' }])),
    session: () => ok('live'),
    anchor: () => ok('none'),
    sync: () => ok('current'),
    model: () => ok('sonnet'),
    effort: () => ok('high'),
    grantsAttached: () => ok(new Set()),
    grantsEffective: () => ok(new Set()),
  }
  return { reader: async () => reader }
}

function unavailableSource(field: ObservationFieldName): ObservationSource {
  const converged = convergedSource()
  return {
    reader: async (workstreamId) => {
      const inner = await converged.reader(workstreamId)
      const unavailable: Acquired<never> = { ok: false, reason: 'unavailable' }
      return { ...inner, [fieldMethodName(field)]: () => unavailable }
    },
  }
}

function fieldMethodName(field: ObservationFieldName): keyof ObservationReader {
  const names: Record<ObservationFieldName, keyof ObservationReader> = {
    'observation.power': 'power',
    'observation.construction': 'construction',
    'observation.session': 'session',
    'observation.anchor': 'anchor',
    'observation.sync': 'sync',
    'observation.model': 'model',
    'observation.effort': 'effort',
    'observation.grants.attached': 'grantsAttached',
    'observation.grants.effective': 'grantsEffective',
  }
  return names[field]
}

test('admission is granted when evaluation reaches CONVERGE-001', async () => {
  const decision = await checkAdmission(convergedSource(), 'w1', baseIntent(), RESOLVE)
  assert.deepEqual(decision, { admitted: true })
})

test('admission is granted for an off Intent already off (CONVERGED via POWER-001, not CONVERGE-001)', async () => {
  const reader: ObservationReader = {
    power: () => ok('off'),
    construction: () => {
      throw new Error('must not be read once POWER-001 already converges')
    },
    session: () => {
      throw new Error('must not be read')
    },
    anchor: () => {
      throw new Error('must not be read')
    },
    sync: () => {
      throw new Error('must not be read')
    },
    model: () => {
      throw new Error('must not be read')
    },
    effort: () => {
      throw new Error('must not be read')
    },
    grantsAttached: () => {
      throw new Error('must not be read')
    },
    grantsEffective: () => {
      throw new Error('must not be read')
    },
  }
  const decision = await checkAdmission({ reader: async () => reader }, 'w1', baseIntent({ power: 'off' }), RESOLVE)
  assert.deepEqual(decision, { admitted: true })
})

test('admission is refused when a rule still selects an ACTION (session not yet live)', async () => {
  const decision = await checkAdmission(valueSource('session', 'openable'), 'w1', baseIntent(), RESOLVE)
  assert.equal(decision.admitted, false)
  assert.match(!decision.admitted ? decision.reason : '', /SESSION-00[23]/)
})

test('admission is refused, never guessed, when an observation field is unavailable', async () => {
  const decision = await checkAdmission(unavailableSource('observation.model'), 'w1', baseIntent(), RESOLVE)
  assert.equal(decision.admitted, false)
  assert.match(!decision.admitted ? decision.reason : '', /observation\.model is unavailable/)
})

test('admission is refused when model does not match the Intent', async () => {
  const source = valueSource('model', 'a-different-model')
  const decision = await checkAdmission(source, 'w1', baseIntent(), RESOLVE)
  assert.equal(decision.admitted, false)
  assert.match(!decision.admitted ? decision.reason : '', /CONFIG-001/)
})

function valueSource(method: keyof ObservationReader, value: unknown): ObservationSource {
  const converged = convergedSource()
  return {
    reader: async (workstreamId) => {
      const inner = await converged.reader(workstreamId)
      return { ...inner, [method]: () => ok(value) }
    },
  }
}

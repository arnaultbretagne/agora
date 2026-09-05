import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Acquired, Authorization, Evaluation, Intent, ObservationFieldName, ObservationReader, PowerObservation, RuleResolution, RuleTable } from '../src/index.js'
import { CONVERGED, capabilityId, construction, evaluate, harnessId } from '../src/index.js'

function auth(overrides: { credential?: string; approval?: 'unconditional' | 'required'; tools?: ReadonlySet<string> | 'full' } = {}): Authorization {
  return {
    kind: 'secret',
    credential: overrides.credential ?? 'cred-a',
    tools: overrides.tools ?? new Set(['tool-1']),
    approval: overrides.approval ?? 'unconditional',
    restrictions: [],
  }
}

function ok<T>(value: T): Acquired<T> {
  return { ok: true, value }
}

function unavailable(): Acquired<never> {
  return { ok: false, reason: 'unavailable' }
}

class TestReader implements ObservationReader {
  readonly calls: ObservationFieldName[] = []
  readonly #handlers = new Map<ObservationFieldName, () => Acquired<unknown>>()

  provide(field: ObservationFieldName, value: unknown): this {
    this.#handlers.set(field, () => ok(value))
    return this
  }

  fail(field: ObservationFieldName): this {
    this.#handlers.set(field, () => unavailable())
    return this
  }

  #invoke(field: ObservationFieldName): Acquired<unknown> {
    this.calls.push(field)
    const handler = this.#handlers.get(field)
    if (handler === undefined) {
      throw new Error(`reader method for ${field} must not be called`)
    }
    return handler()
  }

  power(): Acquired<PowerObservation> {
    return this.#invoke('observation.power') as Acquired<PowerObservation>
  }

  construction() {
    return this.#invoke('observation.construction') as ReturnType<ObservationReader['construction']>
  }

  session() {
    return this.#invoke('observation.session') as ReturnType<ObservationReader['session']>
  }

  anchor() {
    return this.#invoke('observation.anchor') as ReturnType<ObservationReader['anchor']>
  }

  sync() {
    return this.#invoke('observation.sync') as ReturnType<ObservationReader['sync']>
  }

  model() {
    return this.#invoke('observation.model') as ReturnType<ObservationReader['model']>
  }

  effort() {
    return this.#invoke('observation.effort') as ReturnType<ObservationReader['effort']>
  }

  grantsAttached() {
    return this.#invoke('observation.grants.attached') as ReturnType<ObservationReader['grantsAttached']>
  }

  grantsEffective() {
    return this.#invoke('observation.grants.effective') as ReturnType<ObservationReader['grantsEffective']>
  }
}

const digest = 'digest-a'
const desiredGrants: ReadonlySet<Authorization> = new Set([auth({ credential: 'cred-a' })])

const resolve: RuleResolution = {
  harnessDigest: () => digest,
  capabilityGrants: () => desiredGrants,
}

const onIntent: Intent = {
  power: 'on',
  harness: harnessId('claude-code'),
  capabilities: new Set([capabilityId('workspace.read')]),
  model: 'model-a',
  effort: 'default',
  persona: 'default',
}

const offIntent: Intent = { ...onIntent, power: 'off' }

function resultOf(evaluation: Evaluation): Evaluation & { kind: 'result' } {
  assert.equal(evaluation.kind, 'result')
  return evaluation as Evaluation & { kind: 'result' }
}

test('POWER-001 converges an off Intent against an empty footprint with only observation.power read', () => {
  const reader = new TestReader().provide('observation.power', 'off')
  const evaluation = evaluate(offIntent, reader, resolve)
  assert.deepEqual(resultOf(evaluation), { kind: 'result', rule: 'POWER-001', result: CONVERGED })
  assert.deepEqual(reader.calls, ['observation.power'])
})

test('an off Intent with an unavailable ACP field still reaches TURN_OFF when power is on', () => {
  const reader = new TestReader().provide('observation.power', 'on')
  const evaluation = evaluate(offIntent, reader, resolve)
  const result = resultOf(evaluation)
  assert.equal(result.rule, 'POWER-002')
  assert.deepEqual(result.result, { kind: 'ACTION', verb: 'TURN_OFF' })
  assert.deepEqual(reader.calls, ['observation.power'])
})

test('CONFIG is never consulted while SESSION is pending', () => {
  const reader = new TestReader()
    .provide('observation.power', 'on')
    .provide('observation.construction', construction([{ digest }]))
    .provide('observation.grants.attached', desiredGrants)
    .provide('observation.grants.effective', desiredGrants)
    .provide('observation.session', 'pending')
  const evaluation = evaluate(onIntent, reader, resolve)
  const result = resultOf(evaluation)
  assert.equal(result.rule, 'SESSION-001')
  assert.deepEqual(result.result, { kind: 'HOLD' })
  assert.deepEqual(reader.calls, [
    'observation.construction',
    'observation.grants.attached',
    'observation.grants.effective',
    'observation.session',
  ])
})

test('the anchor is consulted only when a context can safely be opened', () => {
  const unusable = new TestReader()
    .provide('observation.power', 'on')
    .provide('observation.construction', construction([{ digest }]))
    .provide('observation.grants.attached', desiredGrants)
    .provide('observation.grants.effective', desiredGrants)
    .provide('observation.session', 'unusable')
  const evaluation = evaluate(onIntent, unusable, resolve)
  const result = resultOf(evaluation)
  assert.equal(result.rule, 'SESSION-005')
  assert.deepEqual(result.result, { kind: 'ACTION', verb: 'TURN_OFF' })
  assert.equal(unusable.calls.includes('observation.anchor'), false)
})

test('unavailable evidence becomes acquisition_incomplete, never a value or a verb', () => {
  const reader = new TestReader().fail('observation.power')
  const evaluation = evaluate(offIntent, reader, resolve)
  assert.deepEqual(evaluation, {
    kind: 'acquisition_incomplete',
    rule: 'POWER-001',
    field: 'observation.power',
    reason: 'unavailable',
  })
  assert.deepEqual(reader.calls, ['observation.power'])
})

test('an on Intent passes POWER without consulting observation.power at all', () => {
  const reader = new TestReader().provide('observation.construction', construction([]))
  const evaluation = evaluate(onIntent, reader, resolve)
  const result = resultOf(evaluation)
  assert.equal(result.rule, 'CONSTRUCT-001')
  assert.deepEqual(reader.calls, ['observation.construction'])
  assert.equal(reader.calls.includes('observation.power'), false)
})

test('a fully realized on Intent reaches CONVERGE-001 through every ordered table', () => {
  const reader = new TestReader()
    .provide('observation.power', 'on')
    .provide('observation.construction', construction([{ digest }]))
    .provide('observation.grants.attached', desiredGrants)
    .provide('observation.grants.effective', desiredGrants)
    .provide('observation.session', 'live')
    .provide('observation.model', 'model-a')
    .provide('observation.effort', 'default')
    .provide('observation.sync', 'current')
  const evaluation = evaluate(onIntent, reader, resolve)
  assert.deepEqual(resultOf(evaluation), { kind: 'result', rule: 'CONVERGE-001', result: CONVERGED })
  assert.equal(reader.calls.includes('observation.anchor'), false)
})

test('an inconsistent acquisition is reported with its reason', () => {
  const reader = new TestReader()
    .provide('observation.power', 'on')
    .provide('observation.construction', construction([{ digest }]))
    .fail('observation.grants.attached')
  const evaluation = evaluate(onIntent, reader, resolve)
  assert.deepEqual(evaluation, {
    kind: 'acquisition_incomplete',
    rule: 'CAPS-001',
    field: 'observation.grants.attached',
    reason: 'unavailable',
  })
})

test('a rule set that ends after PASS without a terminal result throws as incomplete by construction', () => {
  const passingTable: RuleTable = {
    file: '000_pass_only',
    rows: [
      {
        id: 'POWER-003',
        needs: [],
        when: () => true,
        result: { kind: 'PASS' },
      },
    ],
  }
  assert.throws(() => evaluate(onIntent, new TestReader(), resolve, [passingTable]), /incomplete rule set/)
})

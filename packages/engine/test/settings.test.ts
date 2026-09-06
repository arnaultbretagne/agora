import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertSettingsCoherent, MissingSettingError, readPinnedSettings, type PinnedSettings } from '../src/settings.js'
import { backoffDelayMs } from '../src/backoff.js'

const settingsPath = new URL('../../../../contracts/catalogue/runtime-settings.json', import.meta.url).pathname
const document = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>

function pinned(): PinnedSettings {
  return readPinnedSettings(document)
}

test('the reviewed settings file loads, and every pinned value carries a reason', () => {
  const settings = pinned()
  assert.ok(settings.engine.claimLeaseMs > 0)
  assert.ok(settings.custody.preservationBudgetMs > 0)
  assert.ok(settings.harness.seamPollIntervalMs > 0)

  // A number with no rationale is a number the next person changes by accident.
  const rationale = document['rationale'] as Record<string, string>
  for (const key of [
    'engine.claimLeaseMs',
    'engine.backoff.maxDelayMs',
    'custody.preservationBudgetMs',
    'custody.captureStabilityWindowMs',
    'custody.syncProofMaxAgeMs',
    'harness.custodyPollIntervalMs',
  ]) {
    assert.ok(typeof rationale[key] === 'string' && rationale[key].length > 20, `${key} has no rationale`)
  }
})

test('a missing setting fails at load, naming itself — there is no default in code to fall back to', () => {
  assert.throws(() => readPinnedSettings({}), (error: unknown) => {
    assert.ok(error instanceof MissingSettingError)
    assert.match(error.path, /^engine\./)
    assert.match(error.message, /this code carries no default for it/)
    return true
  })

  const withoutBudget = structuredClone(document)
  delete (withoutBudget['custody'] as Record<string, unknown>)['preservationBudgetMs']
  assert.throws(() => readPinnedSettings(withoutBudget), /custody\.preservationBudgetMs/)
})

test('the reviewed values are coherent with each other', () => {
  assertSettingsCoherent(pinned())
})

// --- falsification: each rule must actually reject the thing it claims to ------------------------

test('a capture timeout that could eat the whole shutdown budget is rejected', () => {
  const settings = pinned()
  assert.throws(
    () => assertSettingsCoherent({ ...settings, custody: { ...settings.custody, captureTimeoutMs: settings.custody.preservationBudgetMs } }),
    /captureTimeoutMs.*must be under.*preservationBudgetMs/,
  )
})

test('a stability window as long as the capture budget is rejected: two reads could never happen', () => {
  const settings = pinned()
  assert.throws(
    () => assertSettingsCoherent({ ...settings, custody: { ...settings.custody, captureStabilityWindowMs: settings.custody.captureTimeoutMs } }),
    /needs two reads a window apart/,
  )
})

test('a Pod that would not hear a capture request inside the budget is rejected', () => {
  const settings = pinned()
  assert.throws(
    () => assertSettingsCoherent({ ...settings, harness: { ...settings.harness, custodyPollIntervalMs: settings.custody.preservationBudgetMs } }),
    /has to hear the request inside the budget/,
  )
})

test('a lease shorter than a scan interval is rejected: it could be reclaimed under a live worker', () => {
  const settings = pinned()
  assert.throws(
    () => assertSettingsCoherent({ ...settings, engine: { ...settings.engine, claimLeaseMs: settings.engine.tickPollIntervalMs } }),
    /reclaimed under a live worker/,
  )
})

test('an exhausted-row recheck as frequent as an ordinary retry is rejected', () => {
  const settings = pinned()
  assert.throws(
    () => assertSettingsCoherent({ ...settings, engine: { ...settings.engine, backoff: { ...settings.engine.backoff, recheckDelayMs: settings.engine.backoff.maxDelayMs } } }),
    /rechecked more rarely than a retrying one/,
  )
})

test('a sync proof older than one tick is rejected as current evidence', () => {
  const settings = pinned()
  assert.throws(
    () => assertSettingsCoherent({ ...settings, custody: { ...settings.custody, syncProofMaxAgeMs: settings.engine.tickPollIntervalMs + 1 } }),
    /not current evidence/,
  )
})

// --- the backoff policy behaves the way its settings promise -------------------------------------

test('backoff never exceeds its cap, however many attempts, and jitter only ever adds', () => {
  const { backoff } = pinned().engine
  const worst = () => 1
  const none = () => 0
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const delay = backoffDelayMs(backoff, attempt, worst)
    assert.ok(delay <= backoff.maxDelayMs * (1 + backoff.jitterRatio), `attempt ${String(attempt)} produced ${String(delay)}ms`)
    assert.ok(backoffDelayMs(backoff, attempt, none) <= backoff.maxDelayMs)
  }
  // And it does grow: a policy that returned its base delay forever would pass a cap test trivially.
  assert.ok(backoffDelayMs(backoff, 5, none) > backoffDelayMs(backoff, 1, none))
})

test('the jitter spread is bounded by the pinned ratio, so retries scatter without drifting', () => {
  const { backoff } = pinned().engine
  const lowest = backoffDelayMs(backoff, 3, () => 0)
  const highest = backoffDelayMs(backoff, 3, () => 1)
  assert.ok(highest > lowest, 'jitter must actually spread retries')
  assert.ok(highest <= Math.round(lowest * (1 + backoff.jitterRatio)) + 1)
})

test('S13: a call that can outlast the claim it is made under is refused as incoherent', () => {
  // Both of these exist because a call with no deadline froze a reconciliation tick, live, with the
  // work row still claimed — once when a NetworkPolicy dropped the Broker's packets (a denial that
  // hangs rather than refuses), once when an adapter accepted a WebSocket and answered nothing.
  const base = pinned()
  assert.ok(base.engine.ownerRequestTimeoutMs < base.engine.claimLeaseMs)
  assert.ok(base.harness.adapterRequestTimeoutMs < base.engine.claimLeaseMs)
  assertSettingsCoherent(base)

  assert.throws(
    () => assertSettingsCoherent({ ...base, engine: { ...base.engine, ownerRequestTimeoutMs: base.engine.claimLeaseMs } }),
    /ownerRequestTimeoutMs/,
  )
  assert.throws(
    () => assertSettingsCoherent({ ...base, harness: { ...base.harness, adapterRequestTimeoutMs: base.engine.claimLeaseMs + 1 } }),
    /adapterRequestTimeoutMs/,
  )
})

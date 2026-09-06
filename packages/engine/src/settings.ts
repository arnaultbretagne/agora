// The typed settings loader (S11 Step 1 — P7).
//
// Every timing and budget the specifications leave open is pinned in
// `contracts/catalogue/runtime-settings.json`, and this module is the only way to read them. It has
// NO defaults, deliberately: a setting that can silently fall back to a value in code is a setting
// nobody has decided, and the first symptom of that is a production timing nobody can find. A
// missing field fails at startup, naming itself.
export interface BackoffSettings {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly maxAttempts: number
  readonly recheckDelayMs: number
}

export interface EngineSettings {
  readonly claimLeaseMs: number
  readonly claimLimit: number
  readonly tickPollIntervalMs: number
  readonly sweepIntervalMs: number
  readonly publicationBatchSize: number
  readonly publicationSweepIntervalMs: number
  /** How long one owner call may take before the caller gives up and reports the field unavailable. */
  readonly ownerRequestTimeoutMs: number
  readonly backoff: BackoffSettings
}

export interface CustodySettings {
  readonly preservationBudgetMs: number
  readonly captureTimeoutMs: number
  readonly restoreTimeoutMs: number
  readonly maxPayloadBytes: number
  readonly captureStabilityWindowMs: number
  readonly placementTimeoutMs: number
  readonly syncProofMaxAgeMs: number
}

export interface HarnessTimingSettings {
  readonly seamPollIntervalMs: number
  readonly custodyPollIntervalMs: number
  readonly adapterHandshakeTimeoutMs: number
  /** How long one ACP request to an adapter may take. An adapter that answers nothing must not hang a tick. */
  readonly adapterRequestTimeoutMs: number
}

export interface PinnedSettings {
  readonly engine: EngineSettings
  readonly custody: CustodySettings
  readonly harness: HarnessTimingSettings
}

export class MissingSettingError extends Error {
  readonly code = 'missing_setting'

  constructor(readonly path: string) {
    super(`runtime settings are missing ${path}; pin it in contracts/catalogue/runtime-settings.json — this code carries no default for it`)
    this.name = 'MissingSettingError'
  }
}

function positive(source: Record<string, unknown> | undefined, key: string, path: string): number {
  const value = source?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new MissingSettingError(`${path}.${key}`)
  return value
}

function ratio(source: Record<string, unknown> | undefined, key: string, path: string): number {
  const value = source?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new MissingSettingError(`${path}.${key}`)
  return value
}

function section(document: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = document[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Reads the pinned settings out of an already-parsed runtime-settings document. Every field is
 * required; the first missing one throws with its own path, so an operator gets the name of the
 * setting rather than a stack trace about `undefined`.
 */
export function readPinnedSettings(document: Record<string, unknown>): PinnedSettings {
  const engine = section(document, 'engine')
  const backoff = section(engine ?? {}, 'backoff')
  const custody = section(document, 'custody')
  const harness = section(document, 'harness')
  return {
    engine: {
      claimLeaseMs: positive(engine, 'claimLeaseMs', 'engine'),
      claimLimit: positive(engine, 'claimLimit', 'engine'),
      tickPollIntervalMs: positive(engine, 'tickPollIntervalMs', 'engine'),
      sweepIntervalMs: positive(engine, 'sweepIntervalMs', 'engine'),
      publicationBatchSize: positive(engine, 'publicationBatchSize', 'engine'),
      publicationSweepIntervalMs: positive(engine, 'publicationSweepIntervalMs', 'engine'),
      ownerRequestTimeoutMs: positive(engine, 'ownerRequestTimeoutMs', 'engine'),
      backoff: {
        baseDelayMs: positive(backoff, 'baseDelayMs', 'engine.backoff'),
        maxDelayMs: positive(backoff, 'maxDelayMs', 'engine.backoff'),
        jitterRatio: ratio(backoff, 'jitterRatio', 'engine.backoff'),
        maxAttempts: positive(backoff, 'maxAttempts', 'engine.backoff'),
        recheckDelayMs: positive(backoff, 'recheckDelayMs', 'engine.backoff'),
      },
    },
    custody: {
      preservationBudgetMs: positive(custody, 'preservationBudgetMs', 'custody'),
      captureTimeoutMs: positive(custody, 'captureTimeoutMs', 'custody'),
      restoreTimeoutMs: positive(custody, 'restoreTimeoutMs', 'custody'),
      maxPayloadBytes: positive(custody, 'maxPayloadBytes', 'custody'),
      captureStabilityWindowMs: positive(custody, 'captureStabilityWindowMs', 'custody'),
      placementTimeoutMs: positive(custody, 'placementTimeoutMs', 'custody'),
      syncProofMaxAgeMs: positive(custody, 'syncProofMaxAgeMs', 'custody'),
    },
    harness: {
      seamPollIntervalMs: positive(harness, 'seamPollIntervalMs', 'harness'),
      custodyPollIntervalMs: positive(harness, 'custodyPollIntervalMs', 'harness'),
      adapterHandshakeTimeoutMs: positive(harness, 'adapterHandshakeTimeoutMs', 'harness'),
      adapterRequestTimeoutMs: positive(harness, 'adapterRequestTimeoutMs', 'harness'),
    },
  }
}

/**
 * The coherence rules between settings. Each one exists because a violation is invisible until it
 * costs something specific, named here — these are not tidiness checks.
 */
export function assertSettingsCoherent(settings: PinnedSettings): void {
  const problems: string[] = []
  if (settings.custody.captureTimeoutMs >= settings.custody.preservationBudgetMs) {
    // Otherwise one capture can consume the whole shutdown window and leave nothing for committing
    // the Save and advancing the Anchor — the parts that make the capture worth anything.
    problems.push(`custody.captureTimeoutMs (${String(settings.custody.captureTimeoutMs)}) must be under custody.preservationBudgetMs (${String(settings.custody.preservationBudgetMs)})`)
  }
  if (settings.custody.captureStabilityWindowMs >= settings.custody.captureTimeoutMs) {
    // A capture needs at least two reads a window apart; a window as long as the budget can never
    // produce a second read.
    problems.push('custody.captureStabilityWindowMs must be well under custody.captureTimeoutMs: a capture needs two reads a window apart')
  }
  if (settings.harness.custodyPollIntervalMs >= settings.custody.preservationBudgetMs) {
    // The Pod would not even ask what is wanted before the shutdown deadline passed.
    problems.push('harness.custodyPollIntervalMs must be well under custody.preservationBudgetMs: the Pod has to hear the request inside the budget')
  }
  if (settings.engine.backoff.baseDelayMs > settings.engine.backoff.maxDelayMs) {
    problems.push('engine.backoff.baseDelayMs cannot exceed maxDelayMs')
  }
  if (settings.engine.backoff.recheckDelayMs <= settings.engine.backoff.maxDelayMs) {
    // The exhausted-budget recheck is meant to be rarer than an ordinary retry; equal or shorter
    // would make an exhausted row indistinguishable from a retrying one.
    problems.push('engine.backoff.recheckDelayMs must exceed maxDelayMs: an exhausted row is rechecked more rarely than a retrying one')
  }
  if (settings.engine.claimLeaseMs <= settings.engine.tickPollIntervalMs) {
    // A lease shorter than a tick would let a second worker claim a row the first is still acting on.
    problems.push('engine.claimLeaseMs must exceed engine.tickPollIntervalMs: a lease shorter than a scan interval can be reclaimed under a live worker')
  }
  if (settings.engine.ownerRequestTimeoutMs >= settings.engine.claimLeaseMs) {
    // A call that can outlast the claim it is made under is a call that can hang a Workstream: the
    // lease expires, another worker claims the row, and the first is still waiting on an owner that
    // will never answer. Live, exactly this stopped one Workstream reconciling entirely.
    problems.push(`engine.ownerRequestTimeoutMs (${String(settings.engine.ownerRequestTimeoutMs)}) must be under engine.claimLeaseMs (${String(settings.engine.claimLeaseMs)})`)
  }
  if (settings.harness.adapterRequestTimeoutMs >= settings.engine.claimLeaseMs) {
    // Same reason, one layer further out: the probe of an unresponsive adapter happens inside a tick.
    problems.push(`harness.adapterRequestTimeoutMs (${String(settings.harness.adapterRequestTimeoutMs)}) must be under engine.claimLeaseMs (${String(settings.engine.claimLeaseMs)})`)
  }
  if (settings.custody.syncProofMaxAgeMs > settings.engine.tickPollIntervalMs) {
    // A verdict older than a tick is not "current evidence" for the tick that reads it.
    problems.push('custody.syncProofMaxAgeMs must not exceed engine.tickPollIntervalMs: a verdict older than one tick is not current evidence')
  }
  if (problems.length > 0) throw new Error(`runtime settings are incoherent:\n  - ${problems.join('\n  - ')}`)
}

// Metrics (S11 Step 3). A small in-process registry with a Prometheus text rendering — no client
// library, because what is needed is counters and gauges over a handful of closed vocabularies, and
// a dependency that can format histograms is not worth the supply chain it brings.
//
// Label values come from closed sets (a rule id, a verb, an attempt state, an error class), never
// from anything a user typed. That is the same allow-list discipline the logs have, for the same
// reason: a metric label is just a log field that gets stored for longer.
export type Labels = Readonly<Record<string, string>>

interface Series {
  readonly help: string
  readonly type: 'counter' | 'gauge'
  readonly values: Map<string, { labels: Labels; value: number }>
}

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name] ?? ''}`)
    .join(',')
}

export class Metrics {
  readonly #series = new Map<string, Series>()

  #seriesFor(name: string, help: string, type: Series['type']): Series {
    const existing = this.#series.get(name)
    if (existing !== undefined) return existing
    const created: Series = { help, type, values: new Map() }
    this.#series.set(name, created)
    return created
  }

  increment(name: string, help: string, labels: Labels = {}, by = 1): void {
    const series = this.#seriesFor(name, help, 'counter')
    const id = key(labels)
    const current = series.values.get(id)
    series.values.set(id, { labels, value: (current?.value ?? 0) + by })
  }

  set(name: string, help: string, value: number, labels: Labels = {}): void {
    const series = this.#seriesFor(name, help, 'gauge')
    series.values.set(key(labels), { labels, value })
  }

  /** Prometheus text exposition. Stable ordering, so a diff of two scrapes is readable. */
  render(): string {
    const lines: string[] = []
    for (const name of [...this.#series.keys()].sort()) {
      const series = this.#series.get(name)!
      lines.push(`# HELP ${name} ${series.help}`)
      lines.push(`# TYPE ${name} ${series.type}`)
      for (const id of [...series.values.keys()].sort()) {
        const entry = series.values.get(id)!
        const labels = Object.keys(entry.labels).sort().map((label) => `${label}="${escape(entry.labels[label] ?? '')}"`)
        lines.push(`${name}${labels.length > 0 ? `{${labels.join(',')}}` : ''} ${String(entry.value)}`)
      }
    }
    return `${lines.join('\n')}\n`
  }
}

function escape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

/** The names S11 asks for, in one place so two deployables cannot spell the same metric differently. */
export const METRIC = {
  claims: 'agora_engine_claims_total',
  ticks: 'agora_engine_ticks_total',
  evaluations: 'agora_engine_evaluations_total',
  attempts: 'agora_owner_attempts_total',
  holds: 'agora_engine_holds_total',
  ownerLatency: 'agora_owner_request_duration_ms',
  ownerRejections: 'agora_owner_rejections_total',
  unresolvedObligations: 'agora_unresolved_retirement_obligations',
  unknownDispatches: 'agora_unknown_dispatches',
  publicationTargets: 'agora_publication_targets_pending',
} as const

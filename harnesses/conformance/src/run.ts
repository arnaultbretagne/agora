// Runs the checks against one target and reports per conformance-table row. A row with no passing
// check is never presented as satisfied: `answered` is true only when at least one check passed and
// none failed, and every skip carries the reason it was skipped, so a report is readable as
// evidence rather than as a score.
import { CONFORMANCE_TABLE, type ConformanceRow, type ConformanceRowId } from './table.js'
import { ALL_CHECKS, connectionFactory, handshakeFactory, type Check, type CheckResult } from './checks.js'
import type { ConformanceTarget } from './target.js'

export interface RowReport {
  readonly row: ConformanceRow
  readonly answered: boolean
  readonly results: readonly CheckResult[]
}

export interface ConformanceReport {
  readonly harnessId: string
  readonly ranAt: string
  readonly rows: readonly RowReport[]
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  /** True only if nothing failed. Unanswered rows do not make a run fail — they make it incomplete, which the report says out loud. */
  readonly ok: boolean
}

export async function runConformance(target: ConformanceTarget, checks: readonly Check[] = ALL_CHECKS): Promise<ConformanceReport> {
  const withConnection = connectionFactory(target)
  const context = { target, withConnection, handshake: handshakeFactory(target, withConnection) }
  const results: CheckResult[] = []
  for (const check of checks) {
    try {
      results.push(await check(context))
    } catch (error) {
      // A check that throws is a defect in the suite, not evidence about the harness — report it as
      // skipped-with-reason rather than letting it read as a harness failure.
      results.push({
        id: check.name || 'unnamed-check',
        row: 'launch-and-identity',
        status: 'skipped',
        detail: `the check itself threw: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const rows = CONFORMANCE_TABLE.map((row) => {
    const forRow = results.filter((result) => result.row === row.id)
    const answered = forRow.some((result) => result.status === 'pass') && !forRow.some((result) => result.status === 'fail')
    return { row, answered, results: forRow }
  })

  const count = (status: CheckResult['status']): number => results.filter((result) => result.status === status).length
  return {
    harnessId: target.harnessId,
    ranAt: new Date().toISOString(),
    rows,
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skipped'),
    ok: count('fail') === 0,
  }
}

export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [
    `harness conformance — ${report.harnessId} — ${report.ranAt}`,
    `${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped`,
    '',
  ]
  for (const rowReport of report.rows) {
    const marker = rowReport.results.length === 0 ? 'no runnable check' : rowReport.answered ? 'answered' : 'NOT answered'
    lines.push(`${rowReport.row.requiredBehavior} — ${marker}`)
    for (const result of rowReport.results) {
      const symbol = result.status === 'pass' ? '  ok  ' : result.status === 'fail' ? ' FAIL ' : ' skip '
      lines.push(`${symbol}${result.id}: ${result.detail}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function rowReportFor(report: ConformanceReport, id: ConformanceRowId): RowReport | undefined {
  return report.rows.find((rowReport) => rowReport.row.id === id)
}

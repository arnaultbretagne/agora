// Enforces the vocabulary invariants of AGENTS.md in implementation and contract files: retired
// product aggregates and identifiers must not reappear. Documentation under docs/ is out of scope
// (it explains the exclusions). Allowlisted occurrences are printed so they never become invisible.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const SCANNED_ROOTS = ['apps', 'harnesses', 'packages', 'contracts', 'scripts']
const EXTENSIONS = /\.(m?ts|m?js|sql|json|ya?ml)$/

// Each pattern targets identifier spellings (snake_case, camelCase, PascalCase), not prose.
const FORBIDDEN = [
  { name: 'run_id', pattern: /\brun_id\b|\brunId\b|\bRunId\b/ },
  { name: 'loge_id', pattern: /\bloge_id\b|\blogeId\b|\bLogeId\b|\bLoge\b/ },
  { name: 'runtime_id', pattern: /\bruntime_id\b|\bruntimeId\b|\bRuntimeId\b/ },
  { name: 'native_session_id', pattern: /\bnative_session_id\b|\bnativeSessionId\b|\bNativeSessionId\b/ },
  { name: 'SessionRuntime', pattern: /SessionRuntime|session_runtime/ },
  { name: 'ExecutionBackend', pattern: /ExecutionBackend|execution_backend/ },
  { name: 'agent_id as harness', pattern: /\bagent_id\b/ },
]

// Legacy client carried over from the archived implementation; its API surface is rewritten when
// the product API contract exists. Each entry names the exact file and vocabulary it tolerates.
const ALLOWLIST = [
  { file: 'apps/web/src/client/api.ts', name: 'SessionRuntime', reason: 'legacy field liveSessionRuntime, removed at plumbing' },
]

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (EXTENSIONS.test(entry.name)) yield path
  }
}

const errors = []
const tolerated = []
let scanned = 0
for (const base of SCANNED_ROOTS) {
  const dir = join(root, base)
  if (!existsSync(dir)) continue
  for (const file of files(dir)) {
    const rel = relative(root, file)
    if (rel === relative(root, new URL(import.meta.url).pathname)) continue
    scanned += 1
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const rule of FORBIDDEN) {
        if (!rule.pattern.test(line)) continue
        const hit = `${rel}:${i + 1} [${rule.name}] ${line.trim().slice(0, 100)}`
        const allowed = ALLOWLIST.find((a) => a.file === rel && a.name === rule.name)
        if (allowed) tolerated.push(`${hit}  (tolerated: ${allowed.reason})`)
        else errors.push(hit)
      }
    })
  }
}

for (const t of tolerated) console.warn(`forbidden vocabulary tolerated: ${t}`)
if (errors.length > 0) {
  console.error('Forbidden vocabulary (AGENTS.md invariants):')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`forbidden vocabulary: ${scanned} file(s) scanned, ${tolerated.length} tolerated, no violation`)

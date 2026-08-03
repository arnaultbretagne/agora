import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

// AGENTS.md "Forbidden concept drift" / docs/adr/index.md "Retired vocabulary". Scoped to `src/`
// only (not `test/`): a test proving a term is REJECTED/ABSENT legitimately mentions it (e.g.
// packages/session-runtime-control/test/no-runtime-id.test.ts); product source never should.
//
// This is a mechanical safety net, not the enforcement mechanism — it catches identifiers a
// grep can see. It does NOT (and cannot reliably) catch structural drift such as "a Session
// Runtime reusable by several Sessions", "a custom semantic protocol around ACP" or "parsed
// custody payloads"; those stay code-review/spec-conformance concerns.

const root = resolve(import.meta.dirname, '..')
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git'])

// Fully retired opaque identifiers: no legitimate use anywhere in the new codebase.
const BANNED_IDENTIFIERS = [/\bruntime_id\b/, /\bruntimeId\b/, /\bloge\b/i, /\bloge_id\b/i, /\bnative_session_id\b/i]

// Only forbidden as a declared TS aggregate/type name — the bare word may appear in prose.
const BANNED_DECLARATIONS = [
  /\b(?:interface|type|class)\s+Conversation\b/,
  /\b(?:interface|type|class)\s+Run\b/,
  /\b(?:interface|type|class)\s+Loge\b/,
  /\b(?:interface|type|class)\s+Thread\b/,
  /\b(?:interface|type|class)\s+Channel\b/,
  /\b(?:interface|type|class)\s+Pipe\b/,
]

async function walkSrcFiles(dir) {
  const files = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  await walk(dir)
  return files
}

const errors = []
let scanned = 0

for (const group of ['packages', 'apps', 'agents']) {
  const groupPath = join(root, group)
  const members = await readdir(groupPath, { withFileTypes: true }).catch(() => [])
  for (const member of members) {
    if (!member.isDirectory()) continue
    const srcDir = join(groupPath, member.name, 'src')
    for (const file of await walkSrcFiles(srcDir)) {
      scanned += 1
      const text = await readFile(file, 'utf8')
      const location = relative(root, file)
      for (const pattern of BANNED_IDENTIFIERS) {
        if (pattern.test(text)) errors.push(`${location}: retired identifier matching ${pattern}`)
      }
      for (const pattern of BANNED_DECLARATIONS) {
        if (pattern.test(text)) errors.push(`${location}: retired aggregate declaration matching ${pattern}`)
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`no forbidden vocabulary found (${scanned} source files scanned)`)
}

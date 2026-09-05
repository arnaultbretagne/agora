// Enforces ADR 0001: a deployable (apps/*, harnesses/*) may depend on packages/* but never on
// another deployable; a package may never depend on a deployable. Checked on both declared
// workspace dependencies and relative imports that escape the workspace directory.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const DEPLOYABLE_ROOTS = ['apps', 'harnesses']
const PACKAGE_ROOTS = ['packages']

function workspaces() {
  const out = []
  for (const kind of [...DEPLOYABLE_ROOTS, ...PACKAGE_ROOTS]) {
    const base = join(root, kind)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const dir = join(base, name)
      const manifest = join(dir, 'package.json')
      if (!statSync(dir).isDirectory() || !existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      out.push({ dir, kind, name: pkg.name, pkg, deployable: DEPLOYABLE_ROOTS.includes(kind) })
    }
  }
  return out
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.(m?ts|m?js)$/.test(entry.name)) yield path
  }
}

const all = workspaces()
const byName = new Map(all.map((w) => [w.name, w]))
const errors = []

for (const w of all) {
  const declared = { ...(w.pkg.dependencies ?? {}), ...(w.pkg.devDependencies ?? {}), ...(w.pkg.peerDependencies ?? {}) }
  for (const dep of Object.keys(declared)) {
    const target = byName.get(dep)
    if (target?.deployable) errors.push(`${w.name} declares a dependency on deployable ${dep} (${relative(root, target.dir)})`)
  }
  for (const file of sourceFiles(w.dir)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1] ?? match[2]
      if (!spec.startsWith('.')) {
        const target = byName.get(spec.split('/').slice(0, 2).join('/'))
        if (target && target !== w && target.deployable) errors.push(`${relative(root, file)} imports deployable ${spec}`)
        continue
      }
      const resolved = resolve(dirname(file), spec)
      if (!resolved.startsWith(w.dir + '/') && resolved !== w.dir) {
        errors.push(`${relative(root, file)} imports outside its workspace: ${spec}`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error('Dependency direction violations (ADR 0001):')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`dependency direction: ${all.length} workspace(s) checked, no violation`)

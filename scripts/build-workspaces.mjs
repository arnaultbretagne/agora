import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

// `npm run <script> --workspaces` iterates workspaces in directory-listing order, NOT dependency
// order — a fresh checkout (no stale dist/ from a prior build) fails as soon as one package's
// TypeScript needs another @agora/* package's type declarations before that package has ever been
// built. This script topologically sorts by each package.json's own `@agora/*` dependencies and
// builds in that order, so `npm test` is correct on a truly clean checkout — not just lucky given
// leftover dist/ output. Only packages with a `build` script are built.
//
// It runs each package's OWN `build` script rather than assuming that build means `tsc -p <dir>`.
// That assumption was true for twelve of the thirteen packages and silently wrong for the
// thirteenth: `@agora/web` builds `tsc -p . && tsc -p src/client`, the second half emitting the
// browser bundle to `dist/client/`. Running only `tsc -p .` produced a web image with no
// `dist/client/app.js` at all — and because `handleStaticAsset` falls through to the API router
// when a static file is missing, the browser got a `401 Bearer required` for its own script tag.
// The shell rendered from `public/` and the page stayed blank. Local `npm test` never caught it:
// that path runs each workspace's own `test` script, which runs its own `build`, so `dist/client`
// was always present outside Docker — only images built from a clean tree were broken.

const root = resolve(import.meta.dirname, '..')
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function discoverPackages() {
  const packages = new Map() // name -> { dir, deps: string[], hasBuildScript }
  for (const group of ['packages', 'apps', 'agents']) {
    const groupPath = join(root, group)
    const entries = await readdir(groupPath, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(group, entry.name)
      let pkgJson
      try {
        pkgJson = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      if (!pkgJson.name) continue
      const deps = Object.keys(pkgJson.dependencies ?? {}).filter((d) => d.startsWith('@agora/'))
      packages.set(pkgJson.name, { dir, deps, hasBuildScript: Boolean(pkgJson.scripts?.build) })
    }
  }
  return packages
}

function topologicalOrder(packages) {
  const order = []
  const visiting = new Set()
  const visited = new Set()

  function visit(name, path) {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(`dependency cycle: ${[...path, name].join(' -> ')}`)
    }
    const pkg = packages.get(name)
    if (!pkg) return // external or not-yet-created; nothing to build
    visiting.add(name)
    for (const dep of pkg.deps) visit(dep, [...path, name])
    visiting.delete(name)
    visited.add(name)
    order.push(name)
  }

  for (const name of packages.keys()) visit(name, [])
  return order
}

const packages = await discoverPackages()
const order = topologicalOrder(packages)

for (const name of order) {
  const pkg = packages.get(name)
  if (!pkg.hasBuildScript) continue
  console.log(`building ${name} (${pkg.dir})...`)
  // `--workspace` rather than a bare `tsc -p`: the package decides what building it means, and no
  // package's build script re-enters this one, so there is no recursion to guard against.
  const result = spawnSync(npmBin, ['run', 'build', '--workspace', name], { stdio: 'inherit', cwd: root })
  if (result.status !== 0) {
    console.error(`build failed: ${name}`)
    process.exitCode = 1
    break
  }
}

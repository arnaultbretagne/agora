import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

// P01 (plans/01-domain-and-contracts.md): "Architecture test preventing imports from packages
// into deployables or privileged packages into domain." Enforces P00's dependency-directed layout:
//   domain <- stores/adapters <- application services <- deployables
// and "No deployable imports another deployable."

const root = resolve(import.meta.dirname, '..')
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git'])
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"](@agora\/[a-zA-Z0-9-]+)/g

async function listWorkspaceDirs(groupDir) {
  const groupPath = join(root, groupDir)
  const entries = await readdir(groupPath, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => join(groupDir, e.name))
}

// Deployables: apps/* run as standalone services; agents/* build standalone Agent images. Neither
// may be depended on by anything else, and neither may depend on the other (no cross-deployable
// coupling).
const GROUPS = [
  { dir: 'packages', layer: 'package' },
  { dir: 'apps', layer: 'deployable' },
  { dir: 'agents', layer: 'deployable' },
]

const packagesByName = new Map()

for (const { dir, layer } of GROUPS) {
  for (const pkgDir of await listWorkspaceDirs(dir)) {
    const pkgJsonPath = join(root, pkgDir, 'package.json')
    let pkgJson
    try {
      pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
    } catch {
      continue
    }
    if (!pkgJson.name) continue
    packagesByName.set(pkgJson.name, { dir: pkgDir, layer })
  }
}

async function walkTsFiles(dir) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  await walk(dir).catch(() => {})
  return files
}

const errors = []

for (const [importerName, importer] of packagesByName) {
  const files = await walkTsFiles(join(root, importer.dir))
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const importedName = match[1]
      if (importedName === importerName) continue
      const imported = packagesByName.get(importedName)
      if (!imported) continue
      const location = relative(root, file)

      if (importer.layer === 'deployable' && imported.layer === 'deployable') {
        errors.push(`${location}: deployable ${importerName} must not import deployable ${importedName}`)
      }
      if (importer.layer === 'package' && imported.layer === 'deployable') {
        errors.push(`${location}: package ${importerName} must not import deployable ${importedName}`)
      }
      if (importerName === '@agora/domain') {
        errors.push(`${location}: @agora/domain must not import any other Agora package (found ${importedName})`)
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`architecture boundaries hold (${packagesByName.size} workspace packages scanned)`)
}

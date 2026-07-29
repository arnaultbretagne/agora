import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import SwaggerParser from '@apidevtools/swagger-parser'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage'])
const files = []

async function walk(dir) {
  for (const entry of await readdir(dir)) {
    if (ignored.has(entry)) continue
    const path = join(dir, entry)
    const info = await stat(path)
    if (info.isDirectory()) await walk(path)
    else files.push(path)
  }
}

await walk(root)

const errors = []
const ids = new Map()
const adrStatuses = new Map()
const schemas = []
const openapiFiles = []
const textExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.sql', '.mjs', '.js', '.ts'])

for (const file of files) {
  const ext = extname(file)
  if (!textExtensions.has(ext)) continue
  const text = await readFile(file, 'utf8')

  if (!text.endsWith('\n')) errors.push(`${relative(root, file)}: missing final newline`)

  if (ext === '.json') {
    try {
      const value = JSON.parse(text)
      if (relative(root, file).startsWith('contracts/schemas/')) schemas.push([file, value])
    } catch (error) {
      errors.push(`${relative(root, file)}: invalid JSON: ${error.message}`)
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    try {
      const value = parseYaml(text)
      if (relative(root, file).startsWith('contracts/openapi/')) openapiFiles.push([file, value])
    } catch (error) {
      errors.push(`${relative(root, file)}: invalid YAML: ${error.message}`)
    }
  }

  if (ext !== '.md') continue

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (
      target.startsWith('http:') ||
      target.startsWith('https:') ||
      target.startsWith('#') ||
      target.startsWith('mailto:')
    ) continue
    const path = resolve(dirname(file), target.split('#', 1)[0])
    try {
      await stat(path)
    } catch {
      errors.push(`${relative(root, file)}: broken link ${target}`)
    }
  }

  const adr = relative(root, file).match(/^docs\/adr\/(\d{4})-/)
  if (adr) {
    if (ids.has(adr[1])) {
      errors.push(`duplicate ADR ${adr[1]}: ${ids.get(adr[1])} and ${relative(root, file)}`)
    }
    ids.set(adr[1], relative(root, file))
    const status = text.match(/^- \*\*Status:\*\* (Accepted|Proposed|Superseded)$/m)?.[1]
    if (!status) errors.push(`${relative(root, file)}: missing or invalid ADR status`)
    else adrStatuses.set(adr[1], status)
  }
}

try {
  const index = await readFile(join(root, 'docs', 'adr', 'index.md'), 'utf8')
  const indexed = new Map()
  for (const match of index.matchAll(/^\| \[(\d{4})\]\([^)]+\) \| (Accepted|Proposed|Superseded) \|/gm)) {
    if (indexed.has(match[1])) errors.push(`docs/adr/index.md: duplicate ADR ${match[1]}`)
    indexed.set(match[1], match[2])
  }
  for (const [id, status] of adrStatuses) {
    if (!indexed.has(id)) errors.push(`docs/adr/index.md: ADR ${id} is not indexed`)
    else if (indexed.get(id) !== status) {
      errors.push(`docs/adr/index.md: ADR ${id} status is ${indexed.get(id)}, file says ${status}`)
    }
  }
  for (const id of indexed.keys()) {
    if (!ids.has(id)) errors.push(`docs/adr/index.md: unknown ADR ${id}`)
  }
} catch (error) {
  errors.push(`docs/adr/index.md: cannot validate index: ${error.message}`)
}

try {
  const index = await readFile(join(root, 'docs', 'specs', 'README.md'), 'utf8')
  for (const file of files) {
    const spec = relative(join(root, 'docs', 'specs'), file)
    if (/^\d{2}-[^/]+\.md$/.test(spec) && !index.includes(`](${spec})`)) {
      errors.push(`docs/specs/README.md: normative spec ${spec} is not indexed`)
    }
  }
} catch (error) {
  errors.push(`docs/specs/README.md: cannot validate index: ${error.message}`)
}

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [file, schema] of schemas) {
  try {
    ajv.addSchema(schema)
  } catch (error) {
    errors.push(`${relative(root, file)}: invalid JSON Schema: ${error.message}`)
  }
}
for (const [file, schema] of schemas) {
  try {
    const validator = schema.$id ? ajv.getSchema(schema.$id) : ajv.compile(schema)
    if (!validator) throw new Error(`schema ${schema.$id} was not registered`)
  } catch (error) {
    errors.push(`${relative(root, file)}: unresolved JSON Schema: ${error.message}`)
  }
}

const operationIds = new Map()
const httpMethods = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'])
for (const [file, document] of openapiFiles) {
  try {
    await SwaggerParser.validate(file)
  } catch (error) {
    errors.push(`${relative(root, file)}: invalid OpenAPI: ${error.message}`)
  }
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!httpMethods.has(method)) continue
      if (!operation.operationId) {
        errors.push(`${relative(root, file)}: ${method.toUpperCase()} ${path} has no operationId`)
      } else if (operationIds.has(operation.operationId)) {
        errors.push(
          `${relative(root, file)}: duplicate operationId ${operation.operationId} ` +
            `(also ${operationIds.get(operation.operationId)})`,
        )
      } else {
        operationIds.set(operation.operationId, `${relative(root, file)} ${method.toUpperCase()} ${path}`)
      }
    }
  }
}

const planManifestPath = join(root, 'plans', 'manifest.json')
try {
  const manifest = JSON.parse(await readFile(planManifestPath, 'utf8'))
  const plans = Array.isArray(manifest.plans) ? manifest.plans : []
  const planIds = new Set()
  const decisionGates = new Set()

  if (manifest.version !== 1) errors.push('plans/manifest.json: unsupported or missing version')
  if (!Array.isArray(manifest.plans)) errors.push('plans/manifest.json: plans must be an array')

  for (const plan of plans) {
    if (!/^P\d{2}$/.test(plan.id ?? '')) {
      errors.push(`plans/manifest.json: invalid plan id ${JSON.stringify(plan.id)}`)
      continue
    }
    if (planIds.has(plan.id)) errors.push(`plans/manifest.json: duplicate plan id ${plan.id}`)
    planIds.add(plan.id)
  }

  for (const plan of plans) {
    if (!planIds.has(plan.id)) continue

    if (typeof plan.file !== 'string' || !/^\d{2}-[^/]+\.md$/.test(plan.file)) {
      errors.push(`plans/manifest.json: ${plan.id} has an invalid file`)
    } else {
      try {
        await stat(join(root, 'plans', plan.file))
      } catch {
        errors.push(`plans/manifest.json: ${plan.id} references missing file ${plan.file}`)
      }
    }

    if (!Array.isArray(plan.dependsOn)) {
      errors.push(`plans/manifest.json: ${plan.id}.dependsOn must be an array`)
    } else {
      for (const dependency of plan.dependsOn) {
        if (!planIds.has(dependency)) {
          errors.push(`plans/manifest.json: ${plan.id} has unknown dependency ${dependency}`)
        }
        if (dependency === plan.id) {
          errors.push(`plans/manifest.json: ${plan.id} depends on itself`)
        }
      }
    }

    for (const gate of plan.decisionGates ?? []) {
      decisionGates.add(gate)
      const adrId = /^ADR-(\d{4})$/.exec(gate)?.[1]
      if (!adrId || !ids.has(adrId)) {
        errors.push(`plans/manifest.json: ${plan.id} has unknown decision gate ${gate}`)
      }
    }
  }

  for (const [adrId, status] of adrStatuses) {
    if (status === 'Proposed' && !decisionGates.has(`ADR-${adrId}`)) {
      errors.push(`plans/manifest.json: Proposed ADR-${adrId} is not an implementation gate`)
    }
  }

  const visiting = new Set()
  const visited = new Set()
  const byId = new Map(plans.map((plan) => [plan.id, plan]))

  function visit(planId, path = []) {
    if (visited.has(planId)) return
    if (visiting.has(planId)) {
      errors.push(`plans/manifest.json: dependency cycle ${[...path, planId].join(' -> ')}`)
      return
    }
    visiting.add(planId)
    for (const dependency of byId.get(planId)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...path, planId])
    }
    visiting.delete(planId)
    visited.add(planId)
  }

  for (const planId of planIds) visit(planId)

  const declaredFiles = new Set(plans.map((plan) => plan.file))
  for (const file of files) {
    const planFile = relative(join(root, 'plans'), file)
    if (/^(?!00-)\d{2}-[^/]+\.md$/.test(planFile) && !declaredFiles.has(planFile)) {
      errors.push(`plans/manifest.json: implementation plan ${planFile} is not declared`)
    }
  }
} catch (error) {
  errors.push(`plans/manifest.json: cannot validate manifest: ${error.message}`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`repository checks passed (${files.length} files, ${ids.size} ADRs)`)
}

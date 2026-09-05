// Carried over from archive/pre-design-cleanup-2026-09-05:scripts/run-schema-fixtures.mjs
// (commit f4ff2cc); changes: Ajv 2020-12 draft module (intent.schema.json declares
// $schema 2020-12, the archived schemas were draft-07) — checking logic otherwise unchanged.
// Wired into the root `check` script for slice S1 (docs/plans/S01-domain-core.md, step 2).
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = resolve(import.meta.dirname, '..')
const schemasDir = join(root, 'contracts', 'schemas')
const fixturesDir = join(schemasDir, 'fixtures')

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

const schemaFiles = (await readdir(schemasDir)).filter((f) => f.endsWith('.schema.json'))
const schemasByFile = new Map()

for (const file of schemaFiles) {
  const schema = JSON.parse(await readFile(join(schemasDir, file), 'utf8'))
  ajv.addSchema(schema)
  schemasByFile.set(file, schema)
}

const errors = []

for (const file of schemaFiles) {
  const name = file.replace(/\.schema\.json$/, '')
  const schema = schemasByFile.get(file)
  const validate = ajv.getSchema(schema.$id)

  const dir = join(fixturesDir, name)
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    errors.push(`${name}: missing contracts/schemas/fixtures/${name}/ (needs a valid-*.json and an invalid-*.json)`)
    continue
  }

  const validFixtures = entries.filter((f) => f.startsWith('valid-'))
  const invalidFixtures = entries.filter((f) => f.startsWith('invalid-'))

  if (validFixtures.length === 0) errors.push(`${name}: no valid-*.json fixture`)
  if (invalidFixtures.length === 0) errors.push(`${name}: no invalid-*.json fixture`)

  for (const fixtureFile of validFixtures) {
    const instance = JSON.parse(await readFile(join(dir, fixtureFile), 'utf8'))
    if (!validate(instance)) {
      errors.push(`${name}/${fixtureFile}: expected valid, ajv rejected it: ${ajv.errorsText(validate.errors)}`)
    }
  }

  for (const fixtureFile of invalidFixtures) {
    const instance = JSON.parse(await readFile(join(dir, fixtureFile), 'utf8'))
    if (validate(instance)) {
      errors.push(`${name}/${fixtureFile}: expected invalid, ajv accepted it`)
    }
  }
}

const fixtureDirs = await readdir(fixturesDir).catch(() => [])
const knownNames = new Set(schemaFiles.map((f) => f.replace(/\.schema\.json$/, '')))
for (const dir of fixtureDirs) {
  if (!knownNames.has(dir)) errors.push(`contracts/schemas/fixtures/${dir}: no matching contracts/schemas/${dir}.schema.json`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`schema fixtures passed (${schemaFiles.length} schemas)`)
}

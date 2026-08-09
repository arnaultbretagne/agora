import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Ajv } from 'ajv'
import { getEquipmentCatalogue } from '../src/catalogue.js'

test('required: the real catalogue validates against the actual contracts/schemas/equipment-catalogue.schema.json', async () => {
  const schemaPath = new URL('../../../../contracts/schemas/equipment-catalogue.schema.json', import.meta.url)
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  const catalogue = getEquipmentCatalogue()
  assert.ok(validate(catalogue), JSON.stringify(validate.errors))
})

test('the catalogue is frozen and stable across calls', () => {
  const a = getEquipmentCatalogue()
  const b = getEquipmentCatalogue()
  assert.deepEqual(a, b)
  assert.ok(Object.isFrozen(a))
  assert.ok(Object.isFrozen(a.resources))
})

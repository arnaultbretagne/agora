import SwaggerParser from '@apidevtools/swagger-parser'
import { Ajv } from 'ajv'
import type { ValidateFunction } from 'ajv'

/**
 * Compiles the request-body validator straight from the real contract (not a hand-copy) — the
 * plan's required test "arbitrary image/command/env fields are schema-rejected" only means
 * something if this is the SAME `additionalProperties: false` schema the OpenAPI document defines,
 * with no chance of drifting from it. Mirrors `packages/session-runtime-control`'s own
 * `contract-fixtures.test.ts`, which proves this schema's poison-field behavior against the file.
 */
const CONTRACT_PATH = new URL('../../../../contracts/openapi/session-runtime-control.yaml', import.meta.url).pathname

let cachedValidator: ValidateFunction | undefined

export async function getMaterializeRequestValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator
  const api = (await SwaggerParser.dereference(CONTRACT_PATH)) as unknown as {
    components: { schemas: Record<string, object> }
  }
  const schema = api.components.schemas.MaterializeSessionRuntimeRequest
  if (!schema) throw new Error('contracts/openapi/session-runtime-control.yaml: missing schema MaterializeSessionRuntimeRequest')
  const ajv = new Ajv({ allErrors: true, strict: false })
  cachedValidator = ajv.compile(schema)
  return cachedValidator
}

import SwaggerParser from '@apidevtools/swagger-parser'
import { Ajv } from 'ajv'
import type { ValidateFunction } from 'ajv'

/** Compiles request-body validators straight from the real contract, same idiom as P04's request-schemas.ts. */
const CONTRACT_PATH = new URL('../../../../contracts/openapi/product-api.yaml', import.meta.url).pathname

interface Validators {
  readonly createWorkstream: ValidateFunction
  readonly patchWorkstream: ValidateFunction
  readonly openSession: ValidateFunction
  readonly promptRequest: ValidateFunction
  readonly membershipPut: ValidateFunction
}

let cached: Validators | undefined

export async function getValidators(): Promise<Validators> {
  if (cached) return cached
  const api = (await SwaggerParser.dereference(CONTRACT_PATH)) as unknown as {
    paths: Record<string, Record<string, unknown>>
    components: { schemas: Record<string, object> }
  }
  const ajv = new Ajv({ allErrors: true, strict: false })
  const schemas = api.components.schemas
  const membershipPutBody = (
    api.paths['/workstreams/{workstreamId}/memberships/{principalId}']?.['put'] as {
      requestBody: { content: { 'application/json': { schema: object } } }
    }
  ).requestBody.content['application/json'].schema
  const patchWorkstreamBody = (
    api.paths['/workstreams/{workstreamId}']?.['patch'] as { requestBody: { content: { 'application/json': { schema: object } } } }
  ).requestBody.content['application/json'].schema

  cached = {
    createWorkstream: ajv.compile(schemas['CreateWorkstreamRequest']!),
    patchWorkstream: ajv.compile(patchWorkstreamBody),
    openSession: ajv.compile(schemas['OpenSessionRequest']!),
    promptRequest: ajv.compile(schemas['PromptRequest']!),
    membershipPut: ajv.compile(membershipPutBody),
  }
  return cached
}

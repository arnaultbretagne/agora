import SwaggerParser from '@apidevtools/swagger-parser'
import { Ajv } from 'ajv'
import type { ValidateFunction } from 'ajv'

/** Same convention as apps/session-runtime-controller/src/request-schemas.ts: compile straight
 * from the real contract, never a hand-copy. */
const CONTRACT_PATH = new URL('../../../../contracts/openapi/broker-control.yaml', import.meta.url).pathname

let cached: { issueGrant: ValidateFunction; activateGrant: ValidateFunction } | undefined

export async function getBrokerRequestValidators(): Promise<{ issueGrant: ValidateFunction; activateGrant: ValidateFunction }> {
  if (cached) return cached
  const api = (await SwaggerParser.dereference(CONTRACT_PATH)) as unknown as { components: { schemas: Record<string, object> } }
  const issueGrantSchema = api.components.schemas.IssueGrantRequest
  const activateGrantSchema = api.components.schemas.ActivateGrantRequest
  if (!issueGrantSchema) throw new Error('contracts/openapi/broker-control.yaml: missing schema IssueGrantRequest')
  if (!activateGrantSchema) throw new Error('contracts/openapi/broker-control.yaml: missing schema ActivateGrantRequest')
  const ajv = new Ajv({ allErrors: true, strict: false })
  cached = { issueGrant: ajv.compile(issueGrantSchema), activateGrant: ajv.compile(activateGrantSchema) }
  return cached
}

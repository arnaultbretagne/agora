import { readFile } from 'node:fs/promises'
import { Ajv } from 'ajv'
import type { ValidateFunction } from 'ajv'
import type { AgentRuntimeDefinition } from './types.js'

const SCHEMA_PATH = new URL('../../../../contracts/schemas/agent-runtime.schema.json', import.meta.url)

let cachedValidator: ValidateFunction | undefined

async function getValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: false })
  cachedValidator = ajv.compile(schema)
  return cachedValidator
}

export class InvalidAgentRuntimeDefinitionError extends Error {
  readonly code = 'invalid_agent_runtime_definition'
  readonly errors: unknown

  constructor(errors: unknown) {
    super(`Agent runtime definition failed contracts/schemas/agent-runtime.schema.json: ${JSON.stringify(errors)}`)
    this.name = 'InvalidAgentRuntimeDefinitionError'
    this.errors = errors
  }
}

/**
 * docs/specs/09-agent-registry.md: definitions are operator config, not Browser/product input —
 * this is the ONE place they are trusted to cross from "arbitrary JSON" to `AgentRuntimeDefinition`.
 */
export async function validateAgentRuntimeDefinition(candidate: unknown): Promise<AgentRuntimeDefinition> {
  const validate = await getValidator()
  if (!validate(candidate)) throw new InvalidAgentRuntimeDefinitionError(validate.errors)
  return candidate as AgentRuntimeDefinition
}

export async function validateRegistry(candidates: readonly unknown[]): Promise<AgentRuntimeDefinition[]> {
  const definitions: AgentRuntimeDefinition[] = []
  for (const candidate of candidates) definitions.push(await validateAgentRuntimeDefinition(candidate))
  return definitions
}

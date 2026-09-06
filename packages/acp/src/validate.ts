// Carried over from archive/pre-design-cleanup-2026-09-05:packages/acp/spike/wire-journal.mjs
// (validator derivation, findings §7); changes: compiled against SDK 1.4.0 as a module with an
// explicit verdict type, no timeline/journal coupling.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Ajv2020 } from 'ajv/dist/2020.js'
import * as addFormatsModule from 'ajv-formats'
import type { Direction } from './framing.js'
import type { RpcKind } from './classify.js'

export type ValidationVerdict =
  | { readonly canonical: true; readonly methodSchema: string | null; readonly routedMethod: string | null }
  | { readonly canonical: false; readonly errorClass: 'batch' | 'invalid_json_shape' | 'wrong_direction' | 'method_schema' | 'wire_schema' | 'unsafe_numeric_id'; readonly routedMethod: string | null }

interface MethodDescriptor {
  readonly definitionName: string
  readonly kind: 'request' | 'response' | 'notification'
  readonly method: string
  readonly side: string
}

interface SchemaDef {
  readonly 'x-method'?: string
  readonly 'x-side'?: string
}

const require = createRequire(import.meta.url)
const SCHEMA_PATH = require.resolve('@agentclientprotocol/sdk/schema/schema.json')
const ACP_PACKAGE_ROOT = dirname(dirname(SCHEMA_PATH))
export const ACP_SCHEMA_VERSION = (JSON.parse(readFileSync(join(ACP_PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version

const officialSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  $schema: string
  $defs: Record<string, SchemaDef>
}

const addFormats: (target: Ajv2020) => Ajv2020 = addFormatsModule.default as never
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
ajv.addFormat('uint16', { type: 'number', validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 65_535 })
ajv.addFormat('uint32', { type: 'number', validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295 })
// JavaScript has no lossless uint64 Number representation. This format can enforce the integer
// shape only; the raw-frame capture is what preserves the value (findings §1).
ajv.addFormat('uint64', { type: 'number', validate: (value: number) => Number.isInteger(value) && value >= 0 })

const validateWireSchema = ajv.compile(officialSchema as never)

function classifyDefinitionName(name: string): 'request' | 'response' | 'notification' | null {
  if (name.endsWith('Notification')) return 'notification'
  if (name.endsWith('Request')) return 'request'
  if (name.endsWith('Response')) return 'response'
  return null
}

export const methodDescriptors: readonly MethodDescriptor[] = Object.entries(officialSchema.$defs)
  .filter(([, definition]) => definition['x-method'])
  .map(([definitionName, definition]) => {
    const kind = classifyDefinitionName(definitionName)
    if (kind === null) throw new Error(`cannot classify ACP method schema ${definitionName}`)
    return { definitionName, kind, method: definition['x-method']!, side: definition['x-side'] ?? '' }
  })

export const sessionUpdateVariants: readonly string[] = ((officialSchema.$defs['SessionUpdate'] as { oneOf?: Array<{ properties?: { sessionUpdate?: { const?: string } } }> }).oneOf ?? [])
  .map((variant) => variant.properties?.sessionUpdate?.const)
  .filter((variant): variant is string => typeof variant === 'string')

const methodValidators = new Map<string, ReturnType<typeof ajv.compile>>()

function methodValidator(definitionName: string): ReturnType<typeof ajv.compile> {
  let validator = methodValidators.get(definitionName)
  if (!validator) {
    validator = ajv.compile({ $schema: officialSchema.$schema, $defs: officialSchema.$defs, $ref: `#/$defs/${definitionName}` })
    methodValidators.set(definitionName, validator)
  }
  return validator
}

function expectedMethodSide(direction: Direction, kind: RpcKind): 'client' | 'agent' {
  if (kind === 'response') {
    return direction === 'client_to_agent' ? 'client' : 'agent'
  }
  return direction === 'client_to_agent' ? 'agent' : 'client'
}

export interface ValidationInput {
  readonly direction: Direction
  readonly payload: unknown
  readonly kind: RpcKind
  readonly method: string | null
  readonly correlatedMethod: string | null
  /** Numeric id literals outside the safe-integer range, from the lossless scan. */
  readonly unsafeIds: readonly string[]
}

export function validateAcpMessage(input: ValidationInput): ValidationVerdict {
  const { direction, payload, kind, method, correlatedMethod } = input
  if (kind === 'batch') {
    return { canonical: false, errorClass: 'batch', routedMethod: null }
  }
  if (kind === 'invalid') {
    return { canonical: false, errorClass: 'invalid_json_shape', routedMethod: null }
  }
  // Agora originates string ids; an adapter sending an unsafe numeric id must fix itself
  // upstream (findings §1 — the TypeScript SDK cannot faithfully echo it).
  if (kind === 'request' || kind === 'response') {
    if (input.unsafeIds.some((pointer) => pointer === '$/id')) {
      return { canonical: false, errorClass: 'unsafe_numeric_id', routedMethod: null }
    }
  }

  const validAgainstWireSchema = validateWireSchema(payload) as boolean
  const routedMethod = kind === 'response' ? correlatedMethod : method
  const expectedSide = expectedMethodSide(direction, kind)
  const sameMethodAndKind = methodDescriptors.filter((descriptor) => descriptor.kind === kind && descriptor.method === routedMethod)
  const candidates = sameMethodAndKind.filter((descriptor) => descriptor.side === expectedSide || descriptor.side === 'both' || descriptor.side === 'protocol')

  let validAgainstMethodSchema: boolean | null = null
  let methodSchema: string | null = null

  if (kind === 'response' && typeof payload === 'object' && payload !== null && 'error' in (payload as Record<string, unknown>)) {
    // JSON-RPC error responses have no method-specific result body.
    validAgainstMethodSchema = true
  } else if (candidates.length > 0) {
    const body = kind === 'response' ? (payload as Record<string, unknown>)['result'] : (payload as Record<string, unknown>)['params']
    const attempts = candidates.map((descriptor) => ({ descriptor, valid: methodValidator(descriptor.definitionName)(body) as boolean }))
    const accepted = attempts.find((attempt) => attempt.valid)
    validAgainstMethodSchema = accepted !== undefined
    methodSchema = accepted?.descriptor.definitionName ?? attempts[0]!.descriptor.definitionName
  } else if (sameMethodAndKind.length > 0) {
    // A standard method in the wrong direction is not an extension method.
    return { canonical: false, errorClass: 'wrong_direction', routedMethod }
  }

  if (!validAgainstWireSchema) {
    return { canonical: false, errorClass: 'wire_schema', routedMethod }
  }
  if (validAgainstMethodSchema === false) {
    return { canonical: false, errorClass: 'method_schema', routedMethod }
  }
  return { canonical: true, methodSchema, routedMethod }
}

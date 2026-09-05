import type { CapabilityId, HarnessId } from './ids.js'
import { capabilityId, harnessId } from './ids.js'

export type IntentPower = 'on' | 'off'

export const INTENT_POWER_VALUES = ['on', 'off'] as const

export const FROZEN_PERSONA = 'default'

export type IntentPersona = typeof FROZEN_PERSONA

export interface Intent {
  readonly power: IntentPower
  readonly harness: HarnessId
  readonly capabilities: ReadonlySet<CapabilityId>
  readonly model: string
  readonly effort: string
  readonly persona: IntentPersona
}

export interface CatalogueView {
  readonly harnesses: ReadonlySet<string>
  readonly capabilities: ReadonlySet<string>
  models(harness: string): readonly string[]
  efforts(harness: string, model: string): readonly string[]
}

export type IntentField = 'power' | 'harness' | 'capabilities' | 'model' | 'effort' | 'persona'

export type IntentShapeErrorCode = 'missing' | 'type' | 'value' | 'catalogue'

export interface IntentShapeError {
  readonly field: IntentField
  readonly code: IntentShapeErrorCode
  readonly message: string
}

export type IntentShapeValidation =
  | { readonly valid: true; readonly intent: Intent }
  | { readonly valid: false; readonly errors: readonly IntentShapeError[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function structuralErrors(input: Record<string, unknown>): IntentShapeError[] {
  const errors: IntentShapeError[] = []
  if (!('power' in input)) {
    errors.push({ field: 'power', code: 'missing', message: 'power is required' })
  } else if (input['power'] !== 'on' && input['power'] !== 'off') {
    errors.push({ field: 'power', code: 'value', message: 'power must be exactly "on" or "off"' })
  }
  if (!('harness' in input)) {
    errors.push({ field: 'harness', code: 'missing', message: 'harness is required' })
  } else if (typeof input['harness'] !== 'string' || input['harness'].length === 0) {
    errors.push({ field: 'harness', code: 'type', message: 'harness must be a non-empty harness_id string' })
  }
  if (!('capabilities' in input)) {
    errors.push({ field: 'capabilities', code: 'missing', message: 'capabilities is required' })
  } else {
    const capabilities = input['capabilities']
    if (!Array.isArray(capabilities)) {
      errors.push({ field: 'capabilities', code: 'type', message: 'capabilities must be an array of capability ids' })
    } else {
      const seen = new Set<string>()
      capabilities.forEach((capability, index) => {
        if (typeof capability !== 'string' || capability.length === 0) {
          errors.push({ field: 'capabilities', code: 'type', message: `capabilities[${index}] must be a non-empty capability id string` })
        } else if (seen.has(capability)) {
          errors.push({ field: 'capabilities', code: 'value', message: `capabilities contains the duplicate capability id "${capability}"` })
        } else {
          seen.add(capability)
        }
      })
    }
  }
  if (!('model' in input)) {
    errors.push({ field: 'model', code: 'missing', message: 'model is required' })
  } else if (typeof input['model'] !== 'string' || input['model'].length === 0) {
    errors.push({ field: 'model', code: 'type', message: 'model must be a non-empty model id string' })
  }
  if (!('effort' in input)) {
    errors.push({ field: 'effort', code: 'missing', message: 'effort is required' })
  } else if (typeof input['effort'] !== 'string' || input['effort'].length === 0) {
    errors.push({ field: 'effort', code: 'type', message: 'effort must be a non-empty effort level string' })
  }
  if (!('persona' in input)) {
    errors.push({ field: 'persona', code: 'missing', message: 'persona is required' })
  } else if (input['persona'] !== FROZEN_PERSONA) {
    errors.push({ field: 'persona', code: 'value', message: 'persona is frozen at "default"' })
  }
  return errors
}

function catalogueErrors(input: Record<string, unknown>, catalogue: CatalogueView): IntentShapeError[] {
  const errors: IntentShapeError[] = []
  const harness = input['harness'] as string
  if (!catalogue.harnesses.has(harness)) {
    errors.push({ field: 'harness', code: 'catalogue', message: `harness "${harness}" is not in the reviewed catalogue` })
    return errors
  }
  const models = catalogue.models(harness)
  const model = input['model'] as string
  if (!models.includes(model)) {
    errors.push({ field: 'model', code: 'catalogue', message: `model "${model}" is not advertised by harness "${harness}"` })
    return errors
  }
  const efforts = catalogue.efforts(harness, model)
  const effort = input['effort'] as string
  if (!efforts.includes(effort)) {
    errors.push({ field: 'effort', code: 'catalogue', message: `effort "${effort}" is not valid for model "${model}"` })
  }
  const capabilities = input['capabilities'] as readonly string[]
  for (const capability of capabilities) {
    if (!catalogue.capabilities.has(capability)) {
      errors.push({ field: 'capabilities', code: 'catalogue', message: `capability "${capability}" is not in the reviewed catalogue` })
    }
  }
  return errors
}

export function validateIntentShape(input: unknown, catalogue: CatalogueView): IntentShapeValidation {
  if (!isPlainObject(input)) {
    return {
      valid: false,
      errors: [{ field: 'power', code: 'type', message: 'an Intent request must be a complete object' }],
    }
  }
  const errors = structuralErrors(input)
  if (errors.length > 0) {
    return { valid: false, errors }
  }
  if (input['power'] === 'on') {
    const onErrors = catalogueErrors(input, catalogue)
    if (onErrors.length > 0) {
      return { valid: false, errors: onErrors }
    }
  }
  return {
    valid: true,
    intent: {
      power: input['power'] as IntentPower,
      harness: harnessId(input['harness'] as string),
      capabilities: new Set((input['capabilities'] as readonly string[]).map(capabilityId)),
      model: input['model'] as string,
      effort: input['effort'] as string,
      persona: FROZEN_PERSONA,
    },
  }
}

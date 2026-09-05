declare const brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type WorkstreamId = Brand<string, 'WorkstreamId'>
export type SessionId = Brand<string, 'SessionId'>
export type HarnessId = Brand<string, 'HarnessId'>
export type CapabilityId = Brand<string, 'CapabilityId'>
export type IntentSeq = Brand<number, 'IntentSeq'>
export type WorkGeneration = Brand<number, 'WorkGeneration'>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function namedId<T extends string>(brandName: T, value: string): Brand<string, T> {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${brandName} must be a non-empty string without surrounding whitespace`)
  }
  return value as Brand<string, T>
}

function uuidId<T extends string>(brandName: T, value: string): Brand<string, T> {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${brandName} must be a canonical UUID string`)
  }
  return value as Brand<string, T>
}

function counter<T extends string>(brandName: T, value: number): Brand<number, T> {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${brandName} must be a non-negative safe integer`)
  }
  return value as Brand<number, T>
}

export function workstreamId(value: string): WorkstreamId {
  return uuidId('WorkstreamId', value)
}

export function sessionId(value: string): SessionId {
  return uuidId('SessionId', value)
}

export function harnessId(value: string): HarnessId {
  return namedId('HarnessId', value)
}

export function capabilityId(value: string): CapabilityId {
  return namedId('CapabilityId', value)
}

export function intentSeq(value: number): IntentSeq {
  return counter('IntentSeq', value)
}

export function workGeneration(value: number): WorkGeneration {
  return counter('WorkGeneration', value)
}

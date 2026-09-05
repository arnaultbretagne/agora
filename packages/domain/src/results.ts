import type { Verb } from './verbs.js'

export type Result =
  | { readonly kind: 'PASS' }
  | { readonly kind: 'ACTION'; readonly verb: Verb }
  | { readonly kind: 'HOLD' }
  | { readonly kind: 'CONVERGED' }

export const PASS: Result = { kind: 'PASS' }

export const HOLD: Result = { kind: 'HOLD' }

export const CONVERGED: Result = { kind: 'CONVERGED' }

export function ACTION(verb: Verb): Result {
  return { kind: 'ACTION', verb }
}

/**
 * Lossless JSON scanning, validation-side only (ADR 0004: the canonical value is the raw frame
 * text — this module never feeds a reserialization path).
 *
 * What it answers:
 *  - which numeric literals in the text cannot round-trip a JavaScript Number (outside the
 *    IEEE-754 safe-integer range, e.g. an adapter echoing a uint64 `id`) — such inbound ids are
 *    rejected with a diagnostic (findings §1);
 *  - a structural parse good enough to classify a message without `JSON.parse` precision loss.
 *
 * Numbers within the safe range parse as JS numbers; anything wider keeps its exact literal as a
 * bigint. Nothing here is ever serialized back to JSON.
 */

export interface LosslessParseResult {
  readonly value: unknown
  /** Numeric literals whose value is integral but outside the safe-integer range, with their JSON pointer. */
  readonly unsafeNumbers: readonly string[]
}

export function losslessParse(text: string): LosslessParseResult {
  const unsafe: string[] = []
  let index = 0

  function skipWhitespace(): void {
    while (index < text.length) {
      const char = text[index]
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break
      index += 1
    }
  }

  function expect(char: string): void {
    if (text[index] !== char) throw new Error(`expected '${char}' at ${index}`)
    index += 1
  }

  function parseString(): string {
    expect('"')
    let out = ''
    while (index < text.length) {
      const char = text[index]!
      if (char === '"') {
        index += 1
        return out
      }
      if (char === '\\') {
        const next = text[index + 1]
        index += 2
        if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(text.slice(index, index + 4), 16))
          index += 4
        } else if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === 'r') out += '\r'
        else if (next === 'b') out += '\b'
        else if (next === 'f') out += '\f'
        else out += next ?? ''
        continue
      }
      out += char
      index += 1
    }
    throw new Error('unterminated string')
  }

  function parseNumber(pointer: string): number | bigint {
    const start = index
    if (text[index] === '-') index += 1
    while (index < text.length && text[index]! >= '0' && text[index]! <= '9') index += 1
    let integral = true
    if (text[index] === '.') {
      integral = false
      index += 1
      while (index < text.length && text[index]! >= '0' && text[index]! <= '9') index += 1
    }
    if (text[index] === 'e' || text[index] === 'E') {
      integral = false
      index += 1
      if (text[index] === '+' || text[index] === '-') index += 1
      while (index < text.length && text[index]! >= '0' && text[index]! <= '9') index += 1
    }
    const literal = text.slice(start, index)
    if (integral) {
      const value = BigInt(literal)
      if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(literal)
      unsafe.push(pointer)
      return value
    }
    return Number(literal)
  }

  function parseValue(pointer: string): unknown {
    skipWhitespace()
    const char = text[index]
    if (char === '{') {
      index += 1
      const object: Record<string, unknown> = {}
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return object
      }
      for (;;) {
        skipWhitespace()
        const key = parseString()
        skipWhitespace()
        expect(':')
        object[key] = parseValue(`${pointer}/${key}`)
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        expect('}')
        return object
      }
    }
    if (char === '[') {
      index += 1
      const array: unknown[] = []
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return array
      }
      for (;;) {
        array.push(parseValue(`${pointer}/${array.length}`))
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        expect(']')
        return array
      }
    }
    if (char === '"') return parseString()
    if (text.startsWith('true', index)) {
      index += 4
      return true
    }
    if (text.startsWith('false', index)) {
      index += 5
      return false
    }
    if (text.startsWith('null', index)) {
      index += 4
      return null
    }
    return parseNumber(pointer)
  }

  const value = parseValue('$')
  skipWhitespace()
  if (index !== text.length) throw new Error(`trailing content at ${index}`)
  return { value, unsafeNumbers: unsafe }
}

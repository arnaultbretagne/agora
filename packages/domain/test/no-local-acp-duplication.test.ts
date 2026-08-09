import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * ADR 0003: ACP request/response/update/content types come only from the pinned
 * `@agentclientprotocol/sdk`. This package has no ACP connection at all (P01 non-goal), so it must
 * not declare a local type that shadows/forks an ACP shape.
 */
const FORBIDDEN_LOCAL_DECLARATIONS = [
  /\b(?:interface|type)\s+ContentBlock\b/,
  /\b(?:interface|type)\s+SessionUpdate\b/,
  /\b(?:interface|type)\s+PromptResponse\b/,
  /\b(?:interface|type)\s+ToolCallUpdate\b/,
]

test('required: no local type duplicates an ACP ContentBlock/SessionUpdate shape', async () => {
  const srcDir = new URL('../src', import.meta.url).pathname
  for (const file of await readdir(srcDir)) {
    if (!file.endsWith('.ts')) continue
    const text = await readFile(join(srcDir, file), 'utf8')
    for (const pattern of FORBIDDEN_LOCAL_DECLARATIONS) {
      assert.equal(pattern.test(text), false, `${file} must not locally declare ${pattern}`)
    }
  }
})

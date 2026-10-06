// What the agent is told (docs/specs/executions.md, docs/specs/credentials.md): its instructions,
// as an AGENTS.md in the workspace — the one file claude-code, opencode and codex all load as
// project instructions — and the claims of the token it goes out with. Never the token: the
// gateway admits every sandbox, so a token read here would open this execution's access to another.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The text the bridge writes into the workspace, the same for every harness. */
export const INSTRUCTIONS = new URL('./agent-instructions.md', import.meta.url)

export function writeInstructions(workspace: string): void {
  writeFileSync(join(workspace, 'AGENTS.md'), readFileSync(INSTRUCTIONS))
}

/** A JWT's payload, unverified: what it says, for the agent to read. Null when it is no JWT. */
export function claimsOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Replaces the file as a whole: the agent never reads half of it. No readable claims, no file. */
export async function writeAccess(file: string, token: string): Promise<void> {
  const claims = claimsOf(token)
  if (claims === null) return rm(file, { force: true })
  await mkdir(dirname(file), { recursive: true })
  const staging = `${file}.${randomUUID()}.tmp`
  await writeFile(staging, `${JSON.stringify(claims, null, 2)}\n`, { mode: 0o600 })
  await rename(staging, file)
}

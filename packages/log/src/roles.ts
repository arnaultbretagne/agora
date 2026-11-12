// Agora's roles (docs/specs/delegation.md, "A delegation": a role): the cards of apps/flows/roles, read as the
// flows read them (apps/flows/team.py, `parse_card`). A delegate started with `agent_type` is given one.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A role's card: who the agent is, and the harness, model and effort it works with by default. */
export interface Role {
  readonly name: string
  /** What the role does, in a line: what an agent choosing it reads. */
  readonly summary: string
  readonly harness: string
  /** Its harness's own; null when the card leaves it to the pool. */
  readonly model: string | null
  readonly effort: string | null
  /** The card's text: the persona. */
  readonly persona: string
}

/** A card: `key: value` front matter between `---` lines, then the persona in Markdown. */
export function parseRole(source: string): Role {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (match === null) throw new Error('a role card starts with its front matter between --- lines')
  const meta = new Map<string, string>()
  for (const line of match[1]!.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const name = meta.get('role')
  const harness = meta.get('harness')
  if (!name || !harness) throw new Error('a role card names its role and its harness')
  const own = (key: string) => {
    const value = meta.get(key)
    return value === undefined || value === '' || value === 'default' ? null : value
  }
  return { name, summary: meta.get('summary') ?? '', harness, model: own('model'), effort: own('effort'), persona: match[2]!.trim() }
}

/** The cards of a directory, by role; none when it does not exist. */
export function loadRoles(directory: string): Map<string, Role> {
  const roles = new Map<string, Role>()
  if (!existsSync(directory)) return roles
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.md')) continue
    const role = parseRole(readFileSync(join(directory, file), 'utf8'))
    roles.set(role.name, role)
  }
  return roles
}

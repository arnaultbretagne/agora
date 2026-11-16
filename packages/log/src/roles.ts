// Agora's roles (docs/specs/roles.md): the cards of `roles/`, each who an agent is and what it works with by
// default. A Workstream started as one is given its persona by the log, ahead of the first prompt of a new Session.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLE_META } from './marks.ts'

/** A role's card. */
export interface Role {
  readonly name: string
  /** What the role does, in a line: what a person or an agent choosing it reads. */
  readonly summary: string
  readonly harness: string
  /** Its harness's own; null when the card leaves it to the pool. */
  readonly model: string | null
  readonly effort: string | null
  /** The profiles a person's draft starts with when the role is picked; a card gives no right by itself. */
  readonly access: readonly string[]
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
  const access = (meta.get('access') ?? '').split(',').map((profile) => profile.trim()).filter((profile) => profile !== '')
  return { name, summary: meta.get('summary') ?? '', harness, model: own('model'), effort: own('effort'), access, persona: match[2]!.trim() }
}

/** The cards of a directory, by role; none when it does not exist. A file that is no card stops the reading, named. */
export function loadRoles(directory: string): Map<string, Role> {
  const roles = new Map<string, Role>()
  if (!existsSync(directory)) return roles
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.md') || file === 'README.md') continue
    try {
      const role = parseRole(readFileSync(join(directory, file), 'utf8'))
      roles.set(role.name, role)
    } catch (error) {
      throw new Error(`${join(directory, file)}: ${(error as Error).message}`)
    }
  }
  return roles
}

/** What `GET /api/config` says of the roles (docs/specs/roles.md, "Cards"): never a persona. */
export const describeRoles = (roles: ReadonlyMap<string, Role>) =>
  [...roles.values()].map(({ name, summary, harness, model, effort, access }) => ({ role: name, summary, harness, model, effort, access }))

/** A role's block, Agora's own, ahead of a prompt (docs/specs/roles.md, "The persona"). */
export const roleBlock = (role: Role) => ({ type: 'text', text: `From Agora, not the person: your role, \`${role.name}\`.\n\n${role.persona}`, _meta: { [ROLE_META]: role.name } })

// What each image the CI publishes is made of (README.md, "Images in the cluster"): its Dockerfile, what
// it copies from the repository, and the fingerprint of those inputs at a commit. The CI tags each image
// with that fingerprint and builds only those whose fingerprint has no image yet; propose-infra.ts
// compares it with the one deployed. No dependency: Node 24 and git.
//
//   node scripts/inputs.ts <image> [<commit>]   prints the image's fingerprint at that commit (HEAD)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Each image the CI publishes: its Dockerfile, and the harness it runs, if any. */
export function images(): Map<string, { dockerfile: string; harness: string | null }> {
  const out = new Map<string, { dockerfile: string; harness: string | null }>([['agora-server', { dockerfile: 'apps/server/Dockerfile', harness: null }]])
  for (const h of readdirSync('harnesses', { withFileTypes: true }))
    if (h.isDirectory() && existsSync(join('harnesses', h.name, 'Dockerfile'))) out.set(`agora-harness-${h.name}`, { dockerfile: `harnesses/${h.name}/Dockerfile`, harness: h.name })
  return out
}

/** What a Dockerfile copies from the repository: every COPY's sources, but those from another stage. */
export function sources(dockerfile: string): string[] {
  const found = new Set<string>([dockerfile])
  for (const line of readFileSync(dockerfile, 'utf8').split('\n')) {
    const m = /^COPY\s+(.+)$/.exec(line.trim())
    if (!m || /--from=/.test(m[1]!)) continue
    const words = m[1]!.split(/\s+/).filter((w) => !w.startsWith('--'))
    for (const source of words.slice(0, -1)) found.add(source.replace(/\/$/, ''))
  }
  return [...found].sort()
}

/**
 * The inputs' fingerprint: their git object ids at the commit, hashed. Docker builds are not
 * reproducible, so a digest alone would change at every build; the inputs change only when the image does.
 */
export function inputs(dockerfile: string, sha: string): string {
  const ids = sources(dockerfile).map((path) => `${path} ${execFileSync('git', ['rev-parse', `${sha}:${path}`], { encoding: 'utf8' }).trim()}`)
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
}

if (import.meta.main) {
  const [image, sha = 'HEAD'] = process.argv.slice(2)
  const found = image === undefined ? undefined : images().get(image)
  if (found === undefined) {
    console.error(`usage: node scripts/inputs.ts <${[...images().keys()].join('|')}> [<commit>]`)
    process.exit(2)
  }
  console.log(inputs(found.dockerfile, sha))
}

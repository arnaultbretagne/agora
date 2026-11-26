// What each image the CI publishes is made of (README.md, "Images in the cluster"): its Dockerfile, what
// it copies from the repository, and the fingerprint of those inputs at a commit. The CI tags each image
// with that fingerprint and builds only those whose fingerprint has no image yet; propose-infra.ts
// compares it with the one deployed. A harness built on the toolbelt (FROM ${TOOLBELT_IMAGE}) counts the
// toolbelt's inputs as its own: a new toolbelt is a new image of each. The toolbelt itself is built and
// published for them alone, never deployed: it is not one of images(). No dependency: Node 24 and git.
//
//   node scripts/inputs.ts <image> [<commit>]   prints the image's fingerprint at that commit (HEAD), the
//     toolbelt's too (agora-toolbelt)
//   node scripts/inputs.ts --matrix              prints the images as ci.yml's matrix: name, dockerfile, harness,
//     toolbelt (whether it is built on it)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The shared base image of the real harnesses: what an agent's sandbox carries besides its harness. */
export const TOOLBELT = { name: 'agora-toolbelt', dockerfile: 'toolbelt/Dockerfile' } as const

/** Whether a Dockerfile builds a stage on the toolbelt, which the CI gives as the TOOLBELT_IMAGE argument. */
export function fromToolbelt(dockerfile: string): boolean {
  return /^FROM\s+\$\{?TOOLBELT_IMAGE\}?(\s|$)/m.test(readFileSync(dockerfile, 'utf8'))
}

/** Each image the CI publishes and infra-k8s deploys: its Dockerfile, the harness it runs, if any, and whether it is built on the toolbelt. */
export function images(): Map<string, { dockerfile: string; harness: string | null; toolbelt: boolean }> {
  const out = new Map<string, { dockerfile: string; harness: string | null; toolbelt: boolean }>([['agora-server', { dockerfile: 'apps/server/Dockerfile', harness: null, toolbelt: fromToolbelt('apps/server/Dockerfile') }]])
  for (const h of readdirSync('harnesses', { withFileTypes: true })) {
    if (!h.isDirectory() || !existsSync(join('harnesses', h.name, 'Dockerfile'))) continue
    // The name reaches image tags and the CI's matrix: a registry's lowercase name, nothing a step could read as more.
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(h.name)) throw new Error(`harnesses/${h.name}: a harness folder is named in lowercase letters, digits and dashes`)
    const dockerfile = `harnesses/${h.name}/Dockerfile`
    out.set(`agora-harness-${h.name}`, { dockerfile, harness: h.name, toolbelt: fromToolbelt(dockerfile) })
  }
  return out
}

/**
 * What a Dockerfile copies from the repository: every COPY's sources, but those from another stage; and, built
 * on the toolbelt, the toolbelt's.
 */
export function sources(dockerfile: string): string[] {
  const found = new Set<string>([dockerfile])
  if (dockerfile !== TOOLBELT.dockerfile && fromToolbelt(dockerfile)) for (const source of sources(TOOLBELT.dockerfile)) found.add(source)
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
  if (image === '--matrix') {
    console.log(JSON.stringify([...images()].map(([name, { dockerfile, harness, toolbelt }]) => ({ name, dockerfile, harness: harness !== null, toolbelt }))))
    process.exit(0)
  }
  const found = image === TOOLBELT.name ? TOOLBELT : image === undefined ? undefined : images().get(image)
  if (found === undefined) {
    console.error(`usage: node scripts/inputs.ts <${[...images().keys(), TOOLBELT.name].join('|')}> [<commit>]`)
    process.exit(2)
  }
  console.log(inputs(found.dockerfile, sha))
}

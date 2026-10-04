// Proposes the images a CI run published to infra-k8s (README.md, "Images in the cluster"): for each
// image whose inputs changed since the one deployed, its digest goes into infra-k8s's files — the
// server's into apps/agora (kustomization.yaml, images; server-image.yaml), a harness's into its folder
// of the sandbox catalogue (apps/agora-sandboxes/catalogue/<harness>/harness.yaml). Prints the pull
// request's body. No dependency: Node 24 and git.
//
//   node scripts/propose-infra.ts --infra <infra-k8s checkout> --digests <dir: one file per image,
//     named after it, holding its digest> --ref <branch> --sha <commit>
//
// An image's inputs, and their fingerprint, are scripts/inputs.ts's: an image is proposed only when its
// fingerprint differs from the one deployed.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { images, inputs, sources } from './inputs.ts'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '')
const infra = args.get('infra') ?? 'infra'
const digests = args.get('digests') ?? 'digests'
const ref = args.get('ref') ?? 'unknown'
const sha = args.get('sha') ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const short = sha.slice(0, 7)
const REGISTRY = 'ghcr.io/arnaultbretagne'

/** The versions an image installs: `name@x.y.z` in its Dockerfile, and the package.json it copies. */
function versions(dockerfile: string): string {
  const out = new Map<string, string>()
  const text = readFileSync(dockerfile, 'utf8')
  for (const m of text.matchAll(/(?:^|\s)(?:@[\w.-]+\/)?([\w.-]+)@(\d+\.\d+\.\d+[\w.+-]*)/gm)) out.set(m[1]!, m[2]!)
  for (const source of sources(dockerfile).filter((s) => s.startsWith('harnesses/') && s.endsWith('package.json'))) {
    const pkg = JSON.parse(readFileSync(source, 'utf8')) as { dependencies?: Record<string, string>; overrides?: Record<string, string> }
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.overrides })) out.set(name.replace(/^@[\w.-]+\//, ''), version)
  }
  return [...out]
    .map(([name, version]) => `${name} ${version}`)
    .sort()
    .join(', ')
}

/** Versions compared whatever their order. */
const same = (a: string, b: string): boolean => a.split(/,\s*/).sort().join(', ') === b.split(/,\s*/).sort().join(', ')

/** A data file's `data:` section, where its values are: what comes before it is left alone. */
function split(text: string): [string, string] {
  const at = text.indexOf('\ndata:\n')
  if (at < 0) throw new Error('no data section')
  return [text.slice(0, at + 7), text.slice(at + 7)]
}

/** Replaces a `key: value` line of a data file's data, keeping everything else. */
function setLine(text: string, key: string, value: string): string {
  const [head, data] = split(text)
  const re = new RegExp(`^(\\s+${key}: ).*$`, 'm')
  if (!re.test(data)) throw new Error(`no ${key} line`)
  return head + data.replace(re, `$1${value}`)
}
const getLine = (text: string, key: string): string =>
  new RegExp(`^\\s+${key}: (.*)$`, 'm').exec(split(text)[1])?.[1]?.replace(/^"(.*)"$/, '$1') ?? ''

const rows: string[] = []
const skipped: string[] = []
const source = `arnaultbretagne/agora ${ref} ${short}`
for (const [image, { dockerfile, harness }] of images()) {
  const file = join(digests, image)
  if (!existsSync(file)) continue
  const digest = readFileSync(file, 'utf8').trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${image}: not a digest: ${digest}`)
  const fingerprint = inputs(dockerfile, sha)
  if (harness === null) {
    const kustomization = join(infra, 'apps/agora/kustomization.yaml'),
      data = join(infra, 'apps/agora/server-image.yaml')
    const current = readFileSync(data, 'utf8')
    if (getLine(current, 'inputs') === fingerprint) {
      skipped.push(`${image} (inputs unchanged)`)
      continue
    }
    const k = readFileSync(kustomization, 'utf8')
    const pinned = new RegExp(`(name: ${REGISTRY}/agora-server\\n\\s+digest: )sha256:[0-9a-f]{64}`)
    if (!pinned.test(k)) throw new Error('apps/agora/kustomization.yaml: no agora-server digest')
    writeFileSync(kustomization, k.replace(pinned, `$1${digest}`))
    writeFileSync(data, setLine(setLine(current, 'source', source), 'inputs', `"${fingerprint}"`))
    rows.push(`| server | \`agora-server@${digest.slice(0, 19)}…\` | — |`)
  } else {
    const data = join(infra, 'apps/agora-sandboxes/catalogue', harness, 'harness.yaml')
    if (!existsSync(data)) {
      skipped.push(`${image} (no catalogue folder for ${harness}: add it by hand)`)
      continue
    }
    const current = readFileSync(data, 'utf8')
    if (getLine(current, 'inputs') === fingerprint) {
      skipped.push(`${image} (inputs unchanged)`)
      continue
    }
    const before = getLine(current, 'versions'),
      after = versions(dockerfile) || before
    let next = setLine(current, 'name', `${harness}-${digest.slice(7, 19)}`)
    next = setLine(next, 'image', `${REGISTRY}/${image}@${digest}`)
    next = setLine(next, 'versions', after)
    next = setLine(next, 'source', source)
    next = setLine(next, 'inputs', `"${fingerprint}"`)
    writeFileSync(data, next)
    // Versions shown as they were and become: a branch behind the one deployed shows as going back.
    rows.push(`| ${harness} | new pool \`${harness}-${digest.slice(7, 19)}\` (was \`${getLine(current, 'name')}\`) | ${same(before, after) ? after || '—' : `${before || '?'} → **${after}**`} |`)
  }
}

const changed = rows.length > 0
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${String(changed)}\n`)
console.log(`Images published by [${source}](https://github.com/arnaultbretagne/agora/commit/${sha}), whose inputs changed since the ones deployed.

| | Image | Versions |
|---|---|---|
${changed ? rows.join('\n') : '| — | nothing to change | |'}
${skipped.length ? `\nLeft as they are: ${skipped.join(', ')}.\n` : ''}
A harness's new image is a new template and pool, named after its digest: its warm sandboxes come up
in the new pool, the old pool goes with its own. Merging this deploys them (Flux).

🤖 Proposed by Agora's CI (\`scripts/propose-infra.ts\`)`)

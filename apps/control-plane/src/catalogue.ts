import { readFileSync } from 'node:fs'
import type { CatalogueView } from '@agora/domain'
import type { RevisionSet } from '@agora/engine'

// S2 stood in with a small fixed vocabulary for Intent shape validation before any real catalogue
// existed. ENGINE-017's retired-catalogue case is still exercised against an empty view in the
// engine's own tests — this stub stays available for that, and as the default when no real
// catalogue path is configured.
export const STUB_CATALOGUE: CatalogueView = {
  harnesses: new Set(['claude-code']),
  capabilities: new Set(['provider.invoke', 'workspace.read']),
  models: (harness) => (harness === 'claude-code' ? ['model-a', 'model-b'] : []),
  efforts: (_harness, model) => (model === 'model-a' ? ['default', 'high'] : ['default']),
}

export const STUB_REVISION_SET: RevisionSet = { catalogue: 'stub-s2' }

interface HarnessDefinitionsFile {
  readonly harnesses: readonly {
    readonly harnessId: string
    readonly imageDigest: string
    readonly models?: Readonly<Record<string, { readonly efforts: readonly string[] }>>
    readonly workspaceRoot?: string
    readonly configOptionIds?: { readonly model: string; readonly effort: string }
    readonly configReadback?: 'resume' | 'set-config-noop'
    readonly custody?: {
      readonly supportedFormats: readonly { readonly formatId: string; readonly formatVersion: number }[]
      readonly acceptedDriverRevisions: readonly string[]
      readonly workspaceDeps?: Readonly<Record<string, string>>
    }
  }[]
}

/** What a Save must be compatible with to be restorable into this harness (S9 Step 4). */
export interface RestoreHarness {
  readonly harnessId: string
  readonly supportedFormats: readonly { readonly formatId: string; readonly formatVersion: number }[]
  readonly acceptedDriverRevisions: readonly string[]
  readonly workspaceDeps?: Readonly<Record<string, string>>
}

/**
 * The custody half of the reviewed harness definition. A harness that declares none simply has no
 * restorable Saves: observation.anchor stays unavailable for it rather than defaulting to something.
 */
/** The workspace root the reviewed harness definition declares — the same one its PodSpec launches the adapter with. */
export function loadWorkspaceRoot(harnessDefinitionsPath: string, harnessId: string): string | undefined {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  return harnessFile.harnesses.find((h) => h.harnessId === harnessId)?.workspaceRoot
}

/**
 * How this harness names the config options the registered Intent fields map onto (S10 Step 1).
 * Codex calls the effort option `reasoning_effort`; claude-code calls it `effort`. That is a
 * mapping in the reviewed definition, never a second Intent field: the Intent stays
 * `model`/`effort` for every harness, and each definition says what its adapter calls them.
 */
export interface HarnessConfigOptionIds {
  readonly model: string
  readonly effort: string
}

export function loadConfigOptionIds(harnessDefinitionsPath: string): ReadonlyMap<string, HarnessConfigOptionIds> {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  const out = new Map<string, HarnessConfigOptionIds>()
  for (const harness of harnessFile.harnesses) {
    out.set(harness.harnessId, harness.configOptionIds ?? { model: 'model', effort: 'effort' })
  }
  return out
}

/**
 * How a harness answers "what is your current configuration?". `resume` is the natural read;
 * `set-config-noop` exists because codex does not persist a context until it has content, so
 * resuming one that has never been prompted fails outright (measured, harnesses/codex/README.md).
 */
export function loadConfigReadback(harnessDefinitionsPath: string): ReadonlyMap<string, 'resume' | 'set-config-noop'> {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  return new Map(harnessFile.harnesses.map((harness) => [harness.harnessId, harness.configReadback ?? 'resume']))
}

export class DivergentWorkspaceRootsError extends Error {
  constructor(readonly roots: readonly string[]) {
    super(`the reviewed harnesses declare different workspace roots (${roots.join(', ')}); this process opens ACP against one root and cannot serve both`)
    this.name = 'DivergentWorkspaceRootsError'
  }
}

/**
 * The one workspace root every reviewed harness agrees on. The control plane opens ACP against a
 * single root per process (workspace-root.ts), so two harnesses declaring different roots is a
 * configuration error to refuse at startup — not a value to pick between and be silently wrong about
 * for whichever harness lost. Making it per-harness is a real change, and it belongs to whichever
 * slice actually needs two roots.
 */
export function loadSharedWorkspaceRoot(harnessDefinitionsPath: string): string | undefined {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  const roots = [...new Set(harnessFile.harnesses.map((h) => h.workspaceRoot).filter((root): root is string => typeof root === 'string'))]
  if (roots.length > 1) throw new DivergentWorkspaceRootsError(roots)
  return roots[0]
}

export function loadRestoreHarnesses(harnessDefinitionsPath: string): ReadonlyMap<string, RestoreHarness> {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  const out = new Map<string, RestoreHarness>()
  for (const harness of harnessFile.harnesses) {
    if (harness.custody === undefined) continue
    out.set(harness.harnessId, {
      harnessId: harness.harnessId,
      supportedFormats: harness.custody.supportedFormats,
      acceptedDriverRevisions: harness.custody.acceptedDriverRevisions,
      ...(harness.custody.workspaceDeps !== undefined ? { workspaceDeps: harness.custody.workspaceDeps } : {}),
    })
  }
  return out
}

export function loadRestoreHarness(harnessDefinitionsPath: string, harnessId: string): RestoreHarness | undefined {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  const harness = harnessFile.harnesses.find((h) => h.harnessId === harnessId)
  if (harness?.custody === undefined) return undefined
  return {
    harnessId: harness.harnessId,
    supportedFormats: harness.custody.supportedFormats,
    acceptedDriverRevisions: harness.custody.acceptedDriverRevisions,
    ...(harness.custody.workspaceDeps !== undefined ? { workspaceDeps: harness.custody.workspaceDeps } : {}),
  }
}

export interface HarnessDigest {
  readonly harnessId: string
  readonly imageDigest: string
}

/** The reviewed harness_id -> pinned digest mapping (001 Intent, resolve.harnessDigest) — construction compares observed evidence against exactly this, never Intent's own say-so. */
export function loadHarnessDigests(harnessDefinitionsPath: string): readonly HarnessDigest[] {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  return harnessFile.harnesses.map((h) => ({ harnessId: h.harnessId, imageDigest: h.imageDigest }))
}

interface CapabilitiesFile {
  readonly capabilities: readonly { readonly id: string }[]
}

/**
 * The real S8 CatalogueView, read straight from contracts/catalogue/{harness-definitions,
 * capabilities}.json — plain JSON, not apps/runtime-control's own loader: control-plane cannot
 * import that module (ADR 0001, deployable depending on deployable), and the harness/model
 * catalogue and the capability catalogue are otherwise-independent reviewed files anyway.
 */
export function loadCatalogueView(harnessDefinitionsPath: string, capabilitiesPath: string): CatalogueView {
  const harnessFile = JSON.parse(readFileSync(harnessDefinitionsPath, 'utf8')) as HarnessDefinitionsFile
  const capabilitiesFile = JSON.parse(readFileSync(capabilitiesPath, 'utf8')) as CapabilitiesFile

  const harnesses = new Set(harnessFile.harnesses.map((h) => h.harnessId))
  const capabilities = new Set(capabilitiesFile.capabilities.map((c) => c.id))
  const byHarness = new Map(harnessFile.harnesses.map((h) => [h.harnessId, h.models ?? {}]))

  return {
    harnesses,
    capabilities,
    models: (harness) => Object.keys(byHarness.get(harness) ?? {}),
    efforts: (harness, model) => byHarness.get(harness)?.[model]?.efforts ?? [],
  }
}

interface RuntimeSettingsFile {
  readonly bridgePort: number
}

/** The one runtime-settings.json field control-plane itself needs directly (S8 START): the port
 * every harness Pod's bridge server listens on. Everything else in that file is runtime-control's
 * own concern (ADR 0001 — read as plain JSON here, never its loader). */
export function loadBridgePort(runtimeSettingsPath: string): number {
  const settings = JSON.parse(readFileSync(runtimeSettingsPath, 'utf8')) as RuntimeSettingsFile
  return settings.bridgePort
}

export function catalogueRevisionSet(harnessDefinitionsPath: string, capabilitiesPath: string): RevisionSet {
  // A trivial content signature — enough to distinguish "the catalogue changed" for ENGINE-014's
  // "an old attempt cannot resolve a new payload under the same idempotency key" without pulling
  // in a hashing dependency here for two small files read once at process start.
  const combined = readFileSync(harnessDefinitionsPath, 'utf8') + readFileSync(capabilitiesPath, 'utf8')
  let hash = 0
  for (let i = 0; i < combined.length; i += 1) hash = (hash * 31 + combined.charCodeAt(i)) | 0
  return { catalogue: `s8-${hash.toString(16)}` }
}

/**
 * The revision id a publication names, and the one a mutation is fenced against (S10 Step 3). It is
 * the same signature the revision set carries — one value, so "is this process on the selected
 * revision?" is a string comparison rather than a structural one nobody can reason about.
 */
export function catalogueRevisionId(harnessDefinitionsPath: string, capabilitiesPath: string): string {
  return String(catalogueRevisionSet(harnessDefinitionsPath, capabilitiesPath)['catalogue'])
}

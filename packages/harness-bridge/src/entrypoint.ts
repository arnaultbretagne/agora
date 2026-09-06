// The shared harness entrypoint (S10 Step 1). Every harness Pod starts the same way — read the
// PodSpec's environment, wait at the launch seam, place a restored Save if one is offered, spawn the
// pinned adapter, serve the bridge, answer custody requests — and differs only in which binary it
// spawns and which driver it hands custody.
//
// Keeping this in one place is not tidiness: two copies would drift, and the half that drifts is
// always the half nobody is currently looking at.
import type { CustodyDriver } from '@agora/custody'
import { launch, type LaunchOptions } from './launch.js'
import type { BridgeServer } from './bridge-server.js'

export interface HarnessEntrypoint {
  /** The adapter's BIN entry and its arguments. Never a bare package specifier: resolving one lands on the library main, which exits without serving ACP. */
  readonly adapterCommand: readonly string[]
  /** Built from the environment the PodSpec supplied, or undefined where this Pod has no custody paths. */
  readonly driverFor: (paths: { readonly harnessHome: string; readonly workspaceRoot: string }) => CustodyDriver
}

export function optionsFromEnv(env: NodeJS.ProcessEnv, harness: HarnessEntrypoint): LaunchOptions {
  const incarnation = env.AGORA_INCARNATION
  const bridgeAuthSecret = env.BRIDGE_AUTH_SECRET
  const evidenceUrl = env.AGORA_EVIDENCE_URL
  if (incarnation === undefined) throw new Error('AGORA_INCARNATION is required')
  if (bridgeAuthSecret === undefined) throw new Error('BRIDGE_AUTH_SECRET is required')
  if (evidenceUrl === undefined) throw new Error('AGORA_EVIDENCE_URL is required')

  const harnessHome = env.AGORA_HARNESS_HOME
  const workspaceRoot = env.AGORA_WORKSPACE_ROOT
  const custodyUrl = env.AGORA_CUSTODY_URL
  return {
    evidenceUrl,
    incarnation,
    bridgeAuthSecret,
    // All three come from the reviewed catalogue through the PodSpec. Missing any of them means
    // this Pod simply never restores and is never captured: the S8 behaviour, unchanged.
    ...(harnessHome !== undefined && workspaceRoot !== undefined && custodyUrl !== undefined
      ? { custody: { driver: harness.driverFor({ harnessHome, workspaceRoot }), placementUrlBase: custodyUrl } }
      : {}),
    ...(env.AGORA_POD_UID !== undefined ? { podUid: env.AGORA_POD_UID } : {}),
    bridgePort: Number(env.BRIDGE_PORT ?? 8765),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    adapterCommand: harness.adapterCommand,
    onLog: (message: string) => console.log(message),
  }
}

/** What a harness's own `launch.ts` calls when it is the entry module. */
export async function runHarness(harness: HarnessEntrypoint, env: NodeJS.ProcessEnv = process.env): Promise<BridgeServer> {
  return launch(optionsFromEnv(env, harness))
}

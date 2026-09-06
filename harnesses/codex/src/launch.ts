// The codex Pod entrypoint. Everything generic lives in @agora/harness-bridge; this file is the two
// things that are actually this harness's: which binary to spawn, and which driver answers custody.
import { runHarness } from '@agora/harness-bridge'
import { CodexCustodyDriver } from './driver.js'

export const CODEX_ENTRYPOINT = {
  // The adapter's BIN entry, never the bare specifier — the same trap claude-code's README records.
  adapterCommand: ['node', '/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js'],
  driverFor: (paths: { readonly harnessHome: string; readonly workspaceRoot: string }) => new CodexCustodyDriver(paths),
} as const

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  runHarness(CODEX_ENTRYPOINT).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}

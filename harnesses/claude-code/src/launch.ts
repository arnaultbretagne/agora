// The claude-code Pod entrypoint. Everything generic — the seam, the bridge, the custody agent —
// lives in @agora/harness-bridge; this file is the two things that are actually this harness's:
// which binary to spawn, and which driver answers custody.
import { runHarness } from '@agora/harness-bridge'
import { ClaudeCodeCustodyDriver } from './driver.js'

export const CLAUDE_CODE_ENTRYPOINT = {
  // The adapter's BIN entry. Resolving the bare package specifier lands on the library main, which
  // exits cleanly without serving ACP — that cost a live debugging session once (findings §2.2).
  adapterCommand: ['node', '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
  driverFor: (paths: { readonly harnessHome: string; readonly workspaceRoot: string }) => new ClaudeCodeCustodyDriver(paths),
} as const

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  runHarness(CLAUDE_CODE_ENTRYPOINT).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}

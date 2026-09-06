// Runs the suite against a real harness adapter spawned locally, or against a live Pod's bridge.
// Usage (local adapter):
//   node dist/src/cli.js --harness claude-code --adapter <path-to-adapter-entry.js> [--workspace /tmp]
//     [--expect-adapter-name <name> --expect-adapter-version <version>] [--allow-model-spend]
// Usage (live Pod bridge):
//   node dist/src/cli.js --harness claude-code --bridge ws://<pod-ip>:<port>/ --token <p4 bridge token>
//
// `--allow-model-spend` is opt-in on purpose: exactly one check (session/load's recovery evidence)
// costs a real model turn, and no suite should spend money because someone ran it by reflex.
import { formatReport, runConformance } from './run.js'
import { bridgeTarget, spawnedAdapterTarget, type ConformanceTarget } from './target.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main(): Promise<void> {
  const harnessId = flag('harness') ?? 'unknown-harness'
  const workspaceRoot = flag('workspace') ?? '/tmp'
  const allowModelSpend = has('allow-model-spend')
  const expected = {
    ...(flag('expect-adapter-name') === undefined ? {} : { adapterName: flag('expect-adapter-name')! }),
    ...(flag('expect-adapter-version') === undefined ? {} : { adapterVersion: flag('expect-adapter-version')! }),
  }

  const adapter = flag('adapter')
  const bridge = flag('bridge')
  let target: ConformanceTarget
  let shutdown = (): void => {}
  if (adapter !== undefined) {
    const spawned = spawnedAdapterTarget({ harnessId, command: 'node', args: [adapter], workspaceRoot, expected, allowModelSpend })
    target = spawned
    shutdown = spawned.shutdown
  } else if (bridge !== undefined) {
    const token = flag('token')
    if (token === undefined) throw new Error('--bridge requires --token (the P4 bridge token)')
    target = bridgeTarget({ harnessId, url: bridge, token, workspaceRoot, expected, allowModelSpend })
  } else {
    throw new Error('one of --adapter <entry.js> or --bridge <ws url> is required')
  }

  try {
    const report = await runConformance(target)
    process.stdout.write(`${formatReport(report)}\n`)
    process.exitCode = report.ok ? 0 : 1
  } finally {
    shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

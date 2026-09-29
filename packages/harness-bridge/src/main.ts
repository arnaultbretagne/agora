// The image entrypoint (docs/specs/executions.md). Everything it reads is fixed by the image or the
// template — never by a claim, which would force a cold start.
import { nativeDir, pushBundle } from './anchor.ts'
import { publicKeyFrom } from './token.ts'
import { startBridge } from './server.ts'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

const home = required('HOME')
const workspace = process.env.BRIDGE_WORKSPACE ?? '/home/harness/work'
const harness = required('BRIDGE_DRIVER')
const log = (message: string): void => console.log(`[bridge] ${message}`)

const bridge = await startBridge({
  port: Number(process.env.BRIDGE_PORT ?? 8080),
  adapterCommand: JSON.parse(required('BRIDGE_ADAPTER')) as string[],
  workspace,
  podName: required('POD_NAME'),
  publicKey: publicKeyFrom(required('BRIDGE_PUBLIC_KEY')),
  harness,
  nativeDir: nativeDir(harness, home, workspace),
  log,
})

// The end of the Pod (docs/specs/executions.md, "The end of the Pod and the anchor"): the infrastructure deletes it at the
// deadline, and the grace period is for this — stop the adapter, push the native files, leave.
process.on('SIGTERM', () => {
  void (async () => {
    const bundle = await bridge.terminate()
    const url = process.env.AGORA_ANCHOR_URL
    if (url === undefined || url === '') log('AGORA_ANCHOR_URL missing: anchor not pushed')
    else await pushBundle(url, process.env.AGORA_TOKEN_FILE ?? '/var/run/agora/token', bundle, { log })
    process.exit(0)
  })()
})
process.on('SIGINT', () => {
  void bridge.close().finally(() => process.exit(0))
})

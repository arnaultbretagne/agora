// The image entrypoint (sandbox-image.md, "Démarrage, dans le pool"). Everything it reads is fixed
// by the image or the template — never by a claim, which would force a cold start.
import { layoutFor } from '../shared/transcript.ts'
import { publicKeyFrom } from '../shared/token.ts'
import { startBridge } from './server.ts'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} est requis`)
  return value
}

const home = required('HOME')
const workspace = process.env.BRIDGE_WORKSPACE ?? '/home/harness/work'
const adapterCommand = JSON.parse(required('BRIDGE_ADAPTER')) as string[]

const bridge = await startBridge({
  port: Number(process.env.BRIDGE_PORT ?? 8080),
  adapterCommand,
  workspace,
  podName: required('POD_NAME'),
  publicKey: publicKeyFrom(required('BRIDGE_PUBLIC_KEY')),
  layout: layoutFor(required('BRIDGE_DRIVER'), home, workspace),
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void bridge.close().finally(() => process.exit(0))
  })
}

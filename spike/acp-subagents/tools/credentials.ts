// Spike only: the two keys a throwaway harness Pod needs, made the way Agora makes them.
//   node credentials.ts bridge-keys <dir>
//     An Ed25519 pair of our own for the bridge (its public half goes in the Pod's BRIDGE_PUBLIC_KEY):
//     Agora's bridge key is never used.
//   node credentials.ts gateway <grants key file> <pod address> <profile,…> <label> <out file>
//     A gateway token signed with Agora's grants key (read from the given file, /dev/stdin works),
//     bound to the Pod's address, written to <out file> (0600). Nothing is printed.
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { GrantSigner } from '../../../packages/credentials/src/grants.ts'

const [command, ...args] = process.argv.slice(2)
if (command === 'bridge-keys') {
  const dir = args[0]!
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(dir, 'bridge-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(join(dir, 'bridge-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
  console.log('bridge keys written')
} else if (command === 'gateway') {
  const [keyFile, address, profiles, label, out] = args as [string, string, string, string, string]
  const signer = new GrantSigner({
    proxy: 'gateway.agora-gateway.svc.cluster.local:3000',
    keyFile,
    keyId: 'agora-grants-1',
    issuer: 'agora',
    audience: 'agora-gateway',
  })
  const credentials = await signer.mint({ label, ttlSeconds: 3 * 3600, profiles: profiles.split(','), address })
  writeFileSync(out, JSON.stringify(credentials), { mode: 0o600 })
  console.log(`gateway credentials written: proxy ${credentials.proxy}, expires ${credentials.expiresAt}, token ${String(credentials.token.length)} chars`)
} else {
  console.error('usage: credentials.ts bridge-keys <dir> | gateway <key> <address> <profiles> <label> <out>')
  process.exit(2)
}

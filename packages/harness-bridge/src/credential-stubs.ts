// Credential STUBS (S13 — first live deployment; field findings §2.2 and §2.3).
//
// Both pinned harnesses refuse to start without something that looks like a credential on disk or
// in the environment, and neither ever receives a real one: the Broker's relay holds the bearer and
// OneCLI injects it upstream (ADR 0009). What the Pod gets is a fixed marker — `onecli-managed` —
// that selects the right auth MODE and carries no authority whatsoever.
//
// The stubs are catalogue content (contracts/catalogue/harness-definitions.json), handed to the Pod
// through its own PodSpec, and written here before the adapter is spawned. They are not secrets and
// must never become a place a secret could be put, which is why this module refuses an absolute
// path, a traversal, or anything outside the harness's own HOME.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface CredentialStub {
  /** Relative to the harness HOME. `.codex/auth.json`, never `/etc/anything`. */
  readonly path: string
  readonly content: string
}

export function parseCredentialStubs(raw: string | undefined): readonly CredentialStub[] {
  if (raw === undefined || raw.trim() === '') return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('AGORA_CREDENTIAL_STUBS must be a JSON array')
  return parsed.map((entry) => {
    const stub = entry as { path?: unknown; content?: unknown }
    if (typeof stub.path !== 'string' || stub.path.length === 0) throw new Error('a credential stub needs a path')
    if (typeof stub.content !== 'string') throw new Error(`credential stub ${stub.path} needs string content`)
    return { path: stub.path, content: stub.content }
  })
}

/**
 * Writes the stubs under `home`. Returns the absolute paths written, in order, so a caller can log
 * WHICH files a harness was given without logging what is in them.
 */
export function writeCredentialStubs(stubs: readonly CredentialStub[], home: string): readonly string[] {
  const root = resolve(home)
  const written: string[] = []
  for (const stub of stubs) {
    if (isAbsolute(stub.path)) throw new Error(`credential stub path must be relative to HOME: ${stub.path}`)
    const target = resolve(join(root, stub.path))
    const inside = relative(root, target)
    if (inside.startsWith('..')) throw new Error(`credential stub path escapes HOME: ${stub.path}`)
    mkdirSync(dirname(target), { recursive: true })
    // 0600 because the file LOOKS like a credential: anything reading it should find the marker,
    // and nothing should learn from its mode that it is safe to leave lying around.
    writeFileSync(target, stub.content, { mode: 0o600 })
    written.push(target)
  }
  return written
}

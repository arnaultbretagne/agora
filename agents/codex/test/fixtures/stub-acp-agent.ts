import * as acp from '@agentclientprotocol/sdk'
import { createFakeAgent } from '@agora/acp'
import { Readable, Writable } from 'node:stream'

/**
 * Test-only stand-in for `codex-acp` as a real, separate, stdio-speaking process — proves
 * `bridge-server.ts`'s WS<->stdio plumbing, custody-triggering session-id tap and restore-before-
 * ready contract without needing live ChatGPT credentials. `@agora/acp`'s fake Agent is OUR OWN
 * already-real-tested code (P03), not a second thing this test invents.
 */
const stdinReadable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
const stdoutWritable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
const wire = acp.ndJsonStream(stdoutWritable, stdinReadable)
createFakeAgent({ nativeState: { current: undefined } }).connect(wire)

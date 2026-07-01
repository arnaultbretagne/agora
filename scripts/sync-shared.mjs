#!/usr/bin/env node
/**
 * Copy `shared/` into the channel (ADR 0003: shared has no build of its own,
 * it is compiled into each artefact). The channel needs its own copy because a
 * plugin install copies `channel/` OUT of the repo — `../shared` would dangle.
 * The website imports `../shared` live and needs no copy.
 * `website/server.js --check-shared` (and the test suite) assert no drift.
 */
import { copyFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'shared', 'protocol.js')
const dst = join(root, 'channel', 'protocol.js')

copyFileSync(src, dst)
console.log(`synced ${src} -> ${dst} (${readFileSync(dst).length} bytes)`)

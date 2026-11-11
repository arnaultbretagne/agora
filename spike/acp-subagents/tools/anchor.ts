// Spike only: a harness's native directory, copied out of a Pod, read as the bridge reads it at the end
// of a Pod (readBundle), and written as the JSON body Agora PUTs to /anchor.
//   node anchor.ts <harness> <native dir> <out.json>
import { writeFileSync } from 'node:fs'
import { readBundle } from '../../../packages/harness-bridge/src/anchor.ts'

const [harness, dir, out] = process.argv.slice(2) as [string, string, string]
const bundle = await readBundle(harness, dir)
writeFileSync(out, JSON.stringify(bundle))
console.log(`${String(bundle.files.length)} files, stable ${String(bundle.stable)}`)

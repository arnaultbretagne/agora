// The UI is a no-build ES module served straight to the browser, so nothing type-checks it and no
// bundler ever evaluates it. This test does: it loads app.js under a DOM stub and asserts the module
// body runs to completion.
//
// Why it exists: P4 shipped `const state = { equipmentProfile: DEFAULT_PROFILE }` ABOVE
// `const DEFAULT_PROFILE = ...`. A const read before its declaration is a temporal-dead-zone
// ReferenceError, which kills the WHOLE module at load — a blank page, not a broken widget. The site
// was down for hours. The check I had ran the module under bare node and ignored errors matching
// /document|window|localStorage/; `localStorage` threw first, matched the filter, and reported
// "parses OK". It matched a symptom instead of proving the thing, so it hid the bug it existed to
// catch. Hence: stub the DOM properly, and let NOTHING through.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const noop = () => {}
const el = () => ({
  innerHTML: '', value: '', style: {}, dataset: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop, focus: noop,
  querySelector: () => el(), querySelectorAll: () => [], closest: () => null,
  getBoundingClientRect: () => ({ left: 0, width: 100 }),
  scrollHeight: 0, scrollTop: 0, clientHeight: 0, dispatchEvent: noop,
})

globalThis.document = {
  documentElement: { dataset: {}, setAttribute: noop, style: {} },
  body: el(),
  createElement: el,
  querySelector: () => el(),
  querySelectorAll: () => [],
  getElementById: () => el(),
  addEventListener: noop,
}
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop })
globalThis.window = { matchMedia: globalThis.matchMedia, addEventListener: noop, location: { host: 'test', protocol: 'https:' }, innerWidth: 1400 }
globalThis.innerWidth = 1400
globalThis.location = { host: 'test', protocol: 'https:' }
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
globalThis.WebSocket = class { constructor() { this.readyState = 0 } send() {} close() {} addEventListener() {} }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })
globalThis.prompt = () => null
globalThis.confirm = () => false

// app.js calls init() at module load, which is async — its rejection would surface AFTER the test
// ends and be reported as an unhandled rejection, i.e. a real user-visible failure. Capture it.
const asyncErrors = []
process.on('unhandledRejection', (e) => asyncErrors.push(e))

test('app.js evaluates end to end — no temporal-dead-zone, no missing symbol', async () => {
  // A module-level throw rejects the import. That is EXACTLY the blank-page failure, so any rejection
  // is a real bug: this assertion must never be softened into an allow-list of "expected" errors.
  await assert.doesNotReject(
    () => import('../public/app.js'),
    'app.js must evaluate cleanly — a module-level throw is a blank page for the user',
  )
  // Let init()'s microtasks settle, then fail on anything they threw.
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(asyncErrors.map(String), [], 'app.js boot must not throw asynchronously either')
})

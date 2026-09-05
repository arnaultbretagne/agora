/**
 * The browser bundle is the one artefact in this repo that nothing else exercises: `tsc` proves it
 * type-checks, and every other test here talks to the server over HTTP without ever loading a line
 * of it. A module-level throw in `app.js` is therefore invisible to the whole suite and is a BLANK
 * PAGE for the operator, not a broken widget.
 *
 * The OLD UI learned this the hard way: it shipped `const state = { … DEFAULT_PROFILE }` above
 * `const DEFAULT_PROFILE = …`, a temporal-dead-zone ReferenceError that took the site down for
 * hours — and the check that was supposed to catch it ran the module under bare node and IGNORED
 * errors matching /document|window|localStorage/, so `localStorage` threw first, matched the filter,
 * and the check reported "parses OK". It asserted a symptom instead of the property, and hid the
 * exact bug it existed for.
 *
 * So: stub the DOM properly, and let NOTHING through. This assertion must never be softened into an
 * allow-list of "expected" errors.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

interface StubElement {
  innerHTML: string
  value: string
  className: string
  readonly style: Record<string, string>
  readonly dataset: Record<string, string>
  readonly classList: { toggle: () => void; add: () => void; remove: () => void; contains: () => boolean }
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly clientHeight: number
  addEventListener: () => void
  removeEventListener: () => void
  dispatchEvent: () => void
  append: () => void
  remove: () => void
  focus: () => void
  setSelectionRange: () => void
  getAttribute: () => null
  setAttribute: () => void
  querySelector: () => StubElement
  querySelectorAll: () => StubElement[]
  closest: () => null
  getBoundingClientRect: () => { left: number; width: number }
}

const noop = (): void => {}

function stubElement(): StubElement {
  return {
    innerHTML: '',
    value: '',
    className: '',
    style: {},
    dataset: {},
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    append: noop,
    remove: noop,
    focus: noop,
    setSelectionRange: noop,
    getAttribute: () => null,
    setAttribute: noop,
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
  }
}

const globals = globalThis as unknown as Record<string, unknown>

globals['document'] = {
  documentElement: { dataset: {} as Record<string, string>, style: {} },
  body: stubElement(),
  createElement: stubElement,
  getElementById: stubElement,
  querySelector: stubElement,
  querySelectorAll: () => [],
  addEventListener: noop,
}
globals['matchMedia'] = () => ({ matches: false, addEventListener: noop, removeEventListener: noop })
globals['localStorage'] = { getItem: () => null, setItem: noop, removeItem: noop }
globals['prompt'] = () => null
globals['confirm'] = () => false
// `ok: true` with an empty body is the HOSTILE case on purpose: every response is well-formed HTTP
// carrying nothing the client expects, so any code path that assumes a field is present without
// checking blows up here rather than in front of the operator.
globals['fetch'] = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })

// The client installs a repeating list poll, which would keep the test process alive forever. The
// stub records that it was installed so the substitution cannot silently become a no-op that also
// hides a boot failure.
let intervalsInstalled = 0
globals['setInterval'] = (): number => {
  intervalsInstalled += 1
  return 0
}

// `init()` runs at module load and is async, so anything it throws surfaces AFTER the import
// resolves — as an unhandled rejection, i.e. a real user-visible failure. Capture it.
const asyncErrors: unknown[] = []
process.on('unhandledRejection', (error) => asyncErrors.push(error))

test('the browser bundle evaluates end to end — no temporal-dead-zone, no missing symbol', async () => {
  // Imported by URL rather than by specifier so TypeScript resolves nothing at compile time: the
  // subject under test is the EMITTED bundle in dist/client, the same bytes the server serves, not
  // the sources re-compiled under this project's own (DOM-less) settings.
  const bundle = new URL('../client/app.js', import.meta.url).href
  await assert.doesNotReject(
    () => import(bundle),
    'app.js must evaluate cleanly — a module-level throw is a blank page for the user',
  )

  // Let init()'s microtasks and its awaited fetches settle, then fail on anything they threw.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(
    asyncErrors.map(String),
    [],
    'boot must not throw asynchronously either — an unhandled rejection here is a half-rendered app',
  )
  assert.equal(intervalsInstalled, 1, 'boot must reach the end of init(), where the sidebar poll is installed')
})

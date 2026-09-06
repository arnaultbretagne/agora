import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadEgressHostCatalogue, projectReachability } from '../src/reachability.js'

const catalogue = loadEgressHostCatalogue(new URL('../../../../contracts/catalogue/egress-hosts.json', import.meta.url).pathname)

test('a usable secret projects its own reviewed host directly', () => {
  const hosts = projectReachability([{ kind: 'secret', status: 'usable', host: 'api.anthropic.com' }], catalogue)
  assert.deepEqual([...hosts], ['api.anthropic.com'])
})

test('a usable connection projects the catalogue\'s reviewed hosts for its provider', () => {
  const hosts = projectReachability([{ kind: 'connection', status: 'usable', provider: 'github-app' }], catalogue)
  assert.ok(hosts.has('api.github.com'))
  assert.ok(hosts.has('raw.githubusercontent.com'))
})

test('a blocked or limited credential contributes nothing — the relay is not a second opinion', () => {
  const hosts = projectReachability([{ kind: 'secret', status: 'blocked', host: 'api.anthropic.com' }, { kind: 'connection', status: 'limited', provider: 'github-app' }], catalogue)
  assert.equal(hosts.size, 0)
})

test('an unreviewed provider projects to nothing, never guessed open', () => {
  const hosts = projectReachability([{ kind: 'connection', status: 'usable', provider: 'some-unreviewed-app' }], catalogue)
  assert.equal(hosts.size, 0)
})

test('the real catalogue file loads and maps github-app', () => {
  assert.ok(catalogue.hostsFor('github-app').includes('api.github.com'))
  assert.deepEqual(catalogue.hostsFor('unknown-provider'), [])
})

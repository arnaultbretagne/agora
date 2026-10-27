// The cluster through the real gateway (docs/specs/credentials.md, "Kubernetes"): agentgateway 1.6.0 and kubectl
// 1.36.5, their release binaries checked against their sha256, the gateway on fixtures/kubernetes-gateway.yaml;
// tokens signed by Agora's GrantSigner; the bridge's outbound proxy, which adds the token to each CONNECT;
// kubectl with the kubeconfig the bridge names in KUBECONFIG and HTTPS_PROXY pointing at that proxy; and a
// stand-in for the API server over TLS, which records every request and the Authorization it came with.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { after, before, describe, it } from 'node:test'
import { startOutbound, type Outbound } from '@agora/harness-bridge/outbound'
import { GrantSigner } from '../src/index.ts'

const BINARIES = {
  agentgateway: { url: 'https://github.com/agentgateway/agentgateway/releases/download/v1.6.0/agentgateway-linux-amd64', sha256: '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d' },
  kubectl: { url: 'https://dl.k8s.io/release/v1.36.5/bin/linux/amd64/kubectl', sha256: '33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e' },
} as const
/** The kubeconfig the bridge names in the adapter's KUBECONFIG. */
const KUBECONFIG = new URL('../../harness-bridge/src/kubeconfig.yaml', import.meta.url)
/** What the gateway holds for the cluster: a stand-in for its ServiceAccount's token. */
const GATEWAY_CREDENTIAL = 'gateway-serviceaccount-token-stand-in'

let openssl = true
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' })
} catch {
  openssl = false
}
const skip = platform() !== 'linux' || arch() !== 'x64' ? 'the binaries are linux-amd64' : !openssl ? 'openssl is needed to make the certificates' : false

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** A release binary, downloaded once into the temporary directory, and checked before every run. */
async function binary(name: keyof typeof BINARIES): Promise<string> {
  const { url, sha256: expected } = BINARIES[name]
  const dir = join(tmpdir(), `agora-${name}-${expected.slice(0, 12)}`)
  const file = join(dir, name)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const response = await fetch(url)
    assert.equal(response.status, 200, `download ${url}`)
    const partial = `${file}.${randomUUID()}`
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(partial))
    renameSync(partial, file)
  }
  assert.equal(await sha256(file), expected, `${name}, as released`)
  chmodSync(file, 0o755)
  return file
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
}

const POD = { kind: 'Pod', apiVersion: 'v1', metadata: { name: 'server-0', namespace: 'agora', resourceVersion: '7' }, spec: { containers: [{ name: 'server', image: 'agora-server' }] } }

/** A stand-in for the API server: discovery, the pods of `agora`, a watch that sends one event; anything else 404. */
async function apiServer(key: string, cert: string): Promise<{ address: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server: Server = createHttpsServer({ key, cert }, (req, res) => {
    req.resume()
    const url = new URL(req.url ?? '/', 'https://kubernetes.default.svc')
    seen.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization })
    const json = (status: number, body: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.method !== 'GET') return json(405, { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: 405 })
    switch (url.pathname) {
      case '/version':
        return json(200, { major: '1', minor: '36', gitVersion: 'v1.36.4+k0s', platform: 'linux/amd64' })
      case '/api':
        return json(200, { kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [{ clientCIDR: '0.0.0.0/0', serverAddress: '10.0.0.1:6443' }] })
      case '/apis':
        return json(200, { kind: 'APIGroupList', apiVersion: 'v1', groups: [] })
      case '/api/v1':
        return json(200, {
          kind: 'APIResourceList',
          groupVersion: 'v1',
          resources: [{ name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['create', 'delete', 'get', 'list', 'patch', 'watch'], shortNames: ['po'] }],
        })
      case '/api/v1/namespaces/agora/pods':
        if (url.searchParams.get('watch') === 'true') {
          // One event, then the end of the stream: kubectl prints it and stops.
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(`${JSON.stringify({ type: 'ADDED', object: POD })}\n`)
        }
        return json(200, { kind: 'PodList', apiVersion: 'v1', metadata: { resourceVersion: '7' }, items: [POD] })
      case '/api/v1/namespaces/agora/pods/server-0':
        return json(200, POD)
      default:
        return json(404, { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: 404, reason: 'NotFound' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { address: `127.0.0.1:${String(port)}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

describe('the cluster through agentgateway 1.6.0, with kubectl', { skip }, () => {
  let gateway: ChildProcess
  let output = ''
  let api: Awaited<ReturnType<typeof apiServer>>
  let outbound: Outbound
  let signer: GrantSigner
  let kubectlBinary = ''
  let kubeconfig = ''
  let home = ''

  /** kubectl in a sandbox whose bridge holds a token for these profiles, bound to `address`. */
  async function sandbox(profiles: readonly string[], address = '127.0.0.1') {
    outbound.set(await signer.mint({ label: `agora kubernetes-${randomUUID()}`, ttlSeconds: 600, profiles, address }))
    return (...args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        // The environment the bridge gives the adapter, and nothing else of the test's.
        const env = { PATH: '/usr/bin:/bin', HOME: home, HTTPS_PROXY: outbound.url, https_proxy: outbound.url, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', KUBECONFIG: kubeconfig }
        execFile(kubectlBinary, ['--request-timeout=20s', ...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
        })
      })
  }

  const requests = (method: string) => api.seen.filter((s) => s.method === method).length

  before(async () => {
    const [gatewayBinary, kubectl] = [await binary('agentgateway'), await binary('kubectl')]
    kubectlBinary = kubectl
    const dir = mkdtempSync(join(tmpdir(), 'kubernetes-gateway-'))
    home = join(dir, 'home')
    mkdirSync(home)
    const quiet = { stdio: 'ignore' } as const
    // The gateway's CA, which the sandbox trusts.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=Agora gateway CA (test)', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(dir, 'ca-key.pem'), '-out', join(dir, 'ca-cert.pem')], quiet)
    // The cluster's CA, which only the gateway trusts, and the API server's certificate for kubernetes.default.svc.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=kubernetes-ca (test)', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(dir, 'kube-ca-key.pem'), '-out', join(dir, 'kube-ca.pem')], quiet)
    execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=kube-apiserver', '-keyout', join(dir, 'api-key.pem'), '-out', join(dir, 'api.csr')], quiet)
    writeFileSync(join(dir, 'api.ext'), 'subjectAltName=DNS:kubernetes.default.svc,DNS:kubernetes.default.svc.cluster.local\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
    execFileSync('openssl', ['x509', '-req', '-in', join(dir, 'api.csr'), '-CA', join(dir, 'kube-ca.pem'), '-CAkey', join(dir, 'kube-ca-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', join(dir, 'api.ext'), '-out', join(dir, 'api-cert.pem')], quiet)
    api = await apiServer(readFileSync(join(dir, 'api-key.pem'), 'utf8'), readFileSync(join(dir, 'api-cert.pem'), 'utf8'))

    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeFileSync(join(dir, 'grants-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }))
    writeFileSync(join(dir, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'agora-grants-1', alg: 'EdDSA', use: 'sig' }] }))
    writeFileSync(join(dir, 'token'), GATEWAY_CREDENTIAL)
    const [connect, admin, readiness] = [await freePort(), await freePort(), await freePort()]
    const values: Record<string, string> = {
      ADMIN_PORT: String(admin),
      READINESS_PORT: String(readiness),
      CONNECT_PORT: String(connect),
      CA_CERT: join(dir, 'ca-cert.pem'),
      CA_KEY: join(dir, 'ca-key.pem'),
      JWKS: join(dir, 'jwks.json'),
      KUBE_API: api.address,
      KUBE_CA: join(dir, 'kube-ca.pem'),
      KUBE_TOKEN: join(dir, 'token'),
    }
    const config = readFileSync(new URL('./fixtures/kubernetes-gateway.yaml', import.meta.url), 'utf8').replace(/\$\{([A-Z_]+)\}/g, (_, key: string) => values[key] ?? '')
    writeFileSync(join(dir, 'config.yaml'), config)
    // The bridge's kubeconfig as is, but for its root: the template's path holds the gateway's CA in a sandbox.
    const shipped = readFileSync(KUBECONFIG, 'utf8')
    assert.ok(shipped.includes('certificate-authority: /etc/agora/credential-proxy/ca.pem'))
    kubeconfig = join(dir, 'kubeconfig.yaml')
    writeFileSync(kubeconfig, shipped.replace('/etc/agora/credential-proxy/ca.pem', join(dir, 'ca-cert.pem')))

    gateway = spawn(gatewayBinary, ['-f', join(dir, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
    gateway.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    gateway.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const deadline = Date.now() + 30_000
    for (;;) {
      const ready = await fetch(`http://127.0.0.1:${String(readiness)}/healthz/ready`).then((r) => r.status === 200, () => false)
      if (ready) break
      if (Date.now() > deadline || gateway.exitCode !== null) throw new Error(`the gateway did not start:\n${output}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    signer = new GrantSigner({ proxy: `127.0.0.1:${String(connect)}`, keyFile: join(dir, 'grants-key.pem'), keyId: 'agora-grants-1', issuer: 'agora', audience: 'agora-gateway' })
    outbound = await startOutbound({ log: () => {} })
  })

  after(async () => {
    await outbound?.close()
    gateway?.kill()
    await api?.close()
  })

  it('C51 kubernetes:read: kubectl reads — the version, the pods, one pod, a watch — through the bridge and the gateway', async () => {
    const kubectl = await sandbox(['anthropic', 'kubernetes:read'])
    const version = await kubectl('version', '-o', 'json')
    assert.equal(version.code, 0, `${version.stderr}\n${output}`)
    assert.equal((JSON.parse(version.stdout) as { serverVersion?: { gitVersion?: string } }).serverVersion?.gitVersion, 'v1.36.4+k0s')
    const pods = await kubectl('get', 'pods', '-n', 'agora', '-o', 'name')
    assert.deepEqual([pods.code, pods.stdout.trim()], [0, 'pod/server-0'], pods.stderr)
    const pod = await kubectl('get', 'pod', 'server-0', '-n', 'agora', '-o', 'jsonpath={.spec.containers[0].image}')
    assert.deepEqual([pod.code, pod.stdout], [0, 'agora-server'], pod.stderr)
    // A watch is a GET: one event, then the stand-in ends the stream.
    const watch = await kubectl('get', '--raw', '/api/v1/namespaces/agora/pods?watch=true')
    assert.equal(watch.code, 0, watch.stderr)
    assert.equal((JSON.parse(watch.stdout.trim()) as { type: string }).type, 'ADDED')
    assert.ok(api.seen.some((s) => s.path.startsWith('/api/v1/namespaces/agora/pods?') && new URLSearchParams(s.path.split('?')[1]).get('watch') === 'true'), JSON.stringify(api.seen.map((s) => s.path)))
  })

  it('C51 kubernetes:read: kubectl delete, patch and create refused by the gateway, 403, never reaching the API server', async () => {
    const kubectl = await sandbox(['anthropic', 'kubernetes:read'])
    const before = { DELETE: requests('DELETE'), PATCH: requests('PATCH'), POST: requests('POST') }
    const podFile = join(home, 'pod.json')
    writeFileSync(podFile, JSON.stringify(POD))
    for (const args of [
      ['delete', 'pod', 'server-0', '-n', 'agora', '--wait=false'],
      ['patch', 'pod', 'server-0', '-n', 'agora', '-p', '{"metadata":{"labels":{"a":"b"}}}'],
      ['create', '--raw', '/api/v1/namespaces/agora/pods', '-f', podFile],
    ]) {
      const answer = await kubectl(...args)
      assert.notEqual(answer.code, 0, args.join(' '))
      assert.match(answer.stderr, /403|[Ff]orbidden/, `${args.join(' ')}: ${answer.stderr}`)
    }
    assert.deepEqual({ DELETE: requests('DELETE'), PATCH: requests('PATCH'), POST: requests('POST') }, before)
    // Control: the same kubectl, same token, still reads.
    assert.equal((await kubectl('get', 'pods', '-n', 'agora', '-o', 'name')).code, 0)
  })

  it('C52 without kubernetes:read — anthropic alone, internet alone — or from another address: 403 from the gateway, nothing reaches the API server', async () => {
    const count = api.seen.length
    for (const [profiles, address] of [[['anthropic'], '127.0.0.1'], [['internet'], '127.0.0.1'], [['kubernetes:read'], '10.244.9.9']] as const) {
      const answer = await (await sandbox(profiles, address))('get', '--raw', '/version')
      assert.notEqual(answer.code, 0, `${profiles.join(',')} from ${address}`)
      assert.match(answer.stderr, /403|[Ff]orbidden/, `${profiles.join(',')} from ${address}: ${answer.stderr}`)
    }
    assert.equal(api.seen.length, count)
    // Control: kubernetes:read from its own address.
    assert.equal((await (await sandbox(['kubernetes:read']))('get', '--raw', '/version')).code, 0)
    assert.ok(api.seen.length > count)
  })

  it('C51 a password kubectl is given in the sandbox never reaches the API server: the gateway replaces it', async () => {
    const kubectl = await sandbox(['kubernetes:read'])
    const count = api.seen.length
    const answer = await kubectl('get', 'pods', '-n', 'agora', '-o', 'name', '--password=forged-by-the-sandbox')
    assert.equal(answer.code, 0, answer.stderr)
    const after = api.seen.slice(count)
    assert.ok(after.length > 0)
    assert.ok(after.every((s) => s.authorization === `Bearer ${GATEWAY_CREDENTIAL}`), JSON.stringify(after))
  })

  it('C51 over every request above, the API server only ever received the gateway’s credential', () => {
    assert.ok(api.seen.length > 0)
    assert.deepEqual([...new Set(api.seen.map((s) => s.authorization))], [`Bearer ${GATEWAY_CREDENTIAL}`])
  })
})

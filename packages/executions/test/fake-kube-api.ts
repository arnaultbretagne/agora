// FakeKube over HTTP, for an Agora run in another process (a real kill, a real restart): the routes
// HttpKube calls, with each claim's Service rewritten to the address of its bridge in this process.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { KubeError, type Claim, type WatchEvent } from '../src/kube.ts'
import { type FakeKube, NAMESPACE } from './fake-kube.ts'

export interface FakeKubeApi {
  readonly url: string
  close(): Promise<void>
}

function visible(kube: FakeKube, claim: Claim): Claim {
  const copy = structuredClone(claim) as Claim & { status?: { sandbox?: { serviceFQDN?: string; name?: string } } }
  const sandbox = copy.status?.sandbox
  if (sandbox?.name !== undefined && sandbox.serviceFQDN !== undefined) sandbox.serviceFQDN = kube.address(sandbox.serviceFQDN, sandbox.name)
  return copy
}

export async function serveFakeKube(kube: FakeKube): Promise<FakeKubeApi> {
  const prefix = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}`
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://kube')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : undefined
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      try {
        if (url.pathname === `${prefix}/sandboxclaims` && req.method === 'GET' && url.searchParams.get('watch') === '1') {
          res.writeHead(200, { 'content-type': 'application/json' })
          const abort = new AbortController()
          req.on('close', () => abort.abort())
          await kube.watchClaims('', '', (event: WatchEvent) => res.write(`${JSON.stringify({ type: event.type, object: visible(kube, event.object) })}\n`), abort.signal)
          res.end()
          return
        }
        if (url.pathname === `${prefix}/sandboxclaims` && req.method === 'GET') {
          const list = await kube.listClaims()
          return send(200, { items: list.items.map((c) => visible(kube, c)), metadata: { resourceVersion: list.resourceVersion } })
        }
        if (url.pathname === `${prefix}/sandboxclaims` && req.method === 'POST') return send(201, visible(kube, await kube.createClaim(body!)))
        const claim = new RegExp(`^${prefix}/sandboxclaims/([^/]+)$`).exec(url.pathname)
        if (claim && req.method === 'GET') {
          const found = await kube.getClaim(claim[1]!)
          return found ? send(200, visible(kube, found)) : send(404, { message: 'not found' })
        }
        if (claim && req.method === 'PATCH') return send(200, visible(kube, await kube.patchClaim(claim[1]!, body!)))
        if (url.pathname === `${prefix}/sandboxwarmpools`) return send(200, { items: await kube.listPools() })
        if (url.pathname.startsWith(`${prefix}/sandboxtemplates/`)) return send(200, await kube.getTemplate(url.pathname.split('/').at(-1)!))
        if (url.pathname === `/apis/agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxes`) {
          const items = await kube.listSandboxes()
          return send(200, {
            items: items.map((s) => ({ ...s, status: { ...s.status, serviceFQDN: kube.address(s.status?.serviceFQDN ?? '', s.metadata.name) } })),
          })
        }
        if (url.pathname.includes('/sandboxes/')) return send(200, await kube.getSandbox())
        if (url.pathname.startsWith(`/api/v1/namespaces/${NAMESPACE}/pods/`)) return send(200, await kube.getPod(url.pathname.split('/').at(-1)!))
        if (url.pathname === '/apis/authentication.k8s.io/v1/tokenreviews') {
          const token = String((body?.spec as { token?: string } | undefined)?.token)
          const audience = String((body?.spec as { audiences?: string[] } | undefined)?.audiences?.[0])
          const pod = await kube.reviewToken(token)
          return send(201, {
            status: pod
              ? { authenticated: true, audiences: [audience], user: { username: `system:serviceaccount:${pod.namespace}:default`, extra: { 'authentication.kubernetes.io/pod-name': [pod.podName], 'authentication.kubernetes.io/pod-uid': [pod.podUid] } } }
              : { authenticated: false },
          })
        }
        send(404, { message: 'unknown route' })
      } catch (error) {
        send(error instanceof KubeError ? error.status : 500, { message: error instanceof Error ? error.message : 'error' })
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

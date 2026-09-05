import { createWebServer } from './server.js'

const host = process.env['HOST'] ?? '0.0.0.0'
const port = Number(process.env['PORT'] ?? '8080')
const controlPlaneUrl = process.env['CONTROL_PLANE_URL']

const server = createWebServer(controlPlaneUrl ? { controlPlaneUrl } : {})
server.listen(port, host, () => {
  console.log(`@agora/web listening on http://${host}:${port}${controlPlaneUrl ? ` (relay → ${controlPlaneUrl})` : ' (no control plane configured)'}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

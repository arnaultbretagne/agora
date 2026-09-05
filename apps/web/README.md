# `@agora/web`

Human-facing Workstream UI: the browser client under `src/client/` and `public/`, served by a
`node:http` server that does nothing else than serve those files and relay `/v1/*` opaquely to the
control plane API.

The client was carried over from the archived implementation (tag
`archive/pre-design-cleanup-2026-09-05`, `apps/web/src/client`). No framework, no bundler: native
TypeScript compiled to ES modules and served as-is. Its `api.ts` still targets the retired API
surface; it is rewritten when the product API contract exists under `contracts/`. Until then the
relay answers `503 control_plane_not_configured` unless `CONTROL_PLANE_URL` is set.

Configuration: `HOST` (default `0.0.0.0`), `PORT` (default `8080`), `CONTROL_PLANE_URL` (optional).

```sh
npm run build -w @agora/web && npm start -w @agora/web
```

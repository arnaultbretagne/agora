# P05 decision gate: Web framework/toolchain

**Decision:** no framework, no bundler. Native TypeScript compiled straight to native ES modules
(same `tsc -p .` pipeline every other package in this repo uses), served as-is; native DOM APIs in
the browser; the resumable SSE feed read over `fetch()` + a hand-rolled reconnect loop (**not**
`EventSource` — see below); a plain `node:http` server, no Express.

## Why

- Nothing in this repo has a UI framework precedent to match — the system this replaces had none
  either, and every package built so far (`packages/*`, `apps/session-runtime-controller`) already
  demonstrates the same near-zero-dependency posture (hand-verified OpenAPI bindings instead of
  codegen, `node:test` instead of a test framework, a raw `node:https` Kubernetes client instead of
  a client library). A framework here would be the one large exception, not a continuation.
- The data this UI renders is already fully typed at the source: `contracts/schemas/workstream-
  item.schema.json` and `workstream-turn.schema.json` define exact per-kind shapes, and the feed
  protocol (`upsert`/`remove`/`status`/`reset`) is a small, fixed state machine. The main value a
  framework adds — declarative reconciliation of complex, deeply nested, dynamically-shaped state —
  isn't much of a lift here: it's closer to "keyed list of typed cards updated by ID" than a general
  app UI.
- Streaming updates map onto a small, explicit reconnect loop over `fetch()` (see below for why not
  `EventSource`) — no client state library needed to bridge push updates into rendering, since each
  feed event says exactly which item to upsert/remove.
- Solo long-term maintenance favors fewer moving parts to keep current (framework major-version
  churn, bundler config, plugin ecosystems) over a UI whose complexity is bounded and well
  understood in advance.
- Accessible keyboard/screen-reader interactions (an explicit task) are native platform behavior
  first; a framework doesn't reduce this work; and native DOM keeps the semantics closest to the
  platform (no synthetic event layer to route around).

## What this means concretely

- `apps/web/src/server/` — a plain `node:http` server: routing, JSON body parsing, SSE writer, all
  hand-written (same idiom as `apps/session-runtime-controller/src/server.ts`).
- `apps/web/src/client/` — TypeScript compiled to browser-runnable ES modules, imported directly via
  `<script type="module">`; no build-time bundling step, no JSX, no virtual DOM.
- Streaming: `GET /v1/workstreams/{id}/feed` read via `fetch()` + a `ReadableStream` reader, not
  `EventSource` — `EventSource` cannot send custom headers, so it cannot carry this server's
  `Authorization: Bearer <principal>` fake-auth shim. A hand-rolled reconnect loop stands in for
  `EventSource`'s built-in one, using `?after=<last applied position>` on every reconnect, matching
  the resumable-feed contract exactly (`apps/web/src/client/api.ts`'s `subscribeFeed`).
- Rendering: small, explicit per-item-kind render functions keyed by `WorkstreamItem.id`, diffed by
  direct DOM node replacement on `upsert`/`remove` — no reconciliation algorithm needed because the
  feed already identifies exactly what changed.

## Revisit trigger

If the UI later needs client-side routing across many views, complex nested interactive state, or a
component ecosystem (rich text editing, virtualized lists at scale), that is a deliberate reason to
revisit — not a reason to add one preemptively now.

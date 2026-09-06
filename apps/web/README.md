# `@agora/web`

Human-facing Workstream UI: the browser client under `src/client/` and `public/`, served by a
`node:http` server that does nothing else than serve those files and relay `/v1/*` opaquely to the
control plane API.

The shell was carried over from the archived implementation (tag
`archive/pre-design-cleanup-2026-09-05`, `apps/web/src/client`). No framework, no bundler: native
TypeScript compiled to ES modules and served as-is. The relay answers
`503 control_plane_not_configured` unless `CONTROL_PLANE_URL` is set.

**S12 rewrote `api.ts` against `contracts/api/control-plane.openapi.yaml`.** Everything the shell
used to call and no server implements is gone rather than stubbed — an activate/suspend/close/probe
that answers 404 is worse than an absent function, because it implies a lifecycle the design does
not have. There is no Session `phase` for the same reason: a Session is not a state machine
(ADR 0002), and a field named `phase` is an invitation to treat it as one.

## What the operator sees, and where it comes from

| Surface | Derived from | Never |
|---|---|---|
| Status chip | the operational work row (`GET .../intent`) plus this client's own knowledge of an ambiguous send | a stored lifecycle phase — none exists |
| `converged as of <time>` | the absence of a blocking cause, at the moment of rendering | "ready", which is a promise about the future |
| `réconciliation en cours : <cause>` | the work row's `blockingCause`, verbatim, rule id included | a paraphrase — the rule id is what makes it actionable |
| `restreint par la politique` | a cause naming an external restriction (`CAPS-004`) | "we are working on it", which is false when nothing here will change it |
| `livraison incertaine` | a `409` on prompt whose title names delivery (`CONT-005`) | an automatic resend, ever |
| loss banner | `factsSinceAnchor` from `GET .../sessions` (`CONT-012`) | a reassurance: Agora keeps the facts, the native context may not |

## The Intent editor

Four selectors — harness, model, effort, capabilities — every value from `GET /v1/catalogue`, which
is the same view the server validates against. Efforts hang off the model they apply to. Capabilities
are a flat multi-select, because that is what they are: independent facts, no profiles, no
combinations.

Nothing locks. Changing a selection authors a new COMPLETE Intent, and what that implies — replacing
a Pod, ending a Session, restoring an Anchor — is the rule tables' decision. A disabled selector
would be this client claiming to know that decision. Turning power off keeps every other selection,
so turning it back on does not silently land on a different model.

## Permission decisions

A request the agent is blocked on appears between the transcript and the composer, with the options
**the agent itself offered** and nothing else; the control plane refuses an `optionId` outside that
set rather than answering a closed question with an invented value.

Pressing one does not say the permission was granted. It says *Réponse envoyée … en attente de sa
prise en compte par le harnais*, and only when the response frame has been journaled and projected
does the surface report an outcome — quoting what the wire carried, which is not necessarily what
this browser believes it sent. Showing "granted" on a click would be reporting an intention as an
outcome, the same mistake `prompt_delivery_unknown` exists to prevent one step earlier.

The pending list is read from the live channel, not the projection: a projected `permission` item
proves only that a request was *asked*, and offering a button that resolves nothing is worse than
showing nothing. The tie between the two is the tool-call id.

## Accessibility

Native semantics throughout: every control is a real `<button>` with a label, the selectors and
their menus are keyboard-reachable in document order, the banner is `role="status"
aria-live="polite"` so a HOLD or an ambiguous delivery is announced rather than appearing silently,
and each permission request is a `role="group"` labelled by the question its options answer.

What is *not* recorded here is a screen-reader pass: that needs a person with a screen reader, and
claiming it on the strength of correct markup would be exactly the kind of unverified claim the rest
of this repository refuses.

The vocabulary allowlist in `scripts/check-forbidden-vocabulary.mjs` is now empty, and the boot test
still evaluates the whole bundle against hostile empty responses — with no allow-list of expected
errors, which is the point of it.

Configuration: `HOST` (default `0.0.0.0`), `PORT` (default `8080`), `CONTROL_PLANE_URL` (optional).

```sh
npm run build -w @agora/web && npm start -w @agora/web
```

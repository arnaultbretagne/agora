# S12 — Web plumbing completion

- **Status:** merged
- **Depends on:** S4, S8, S9 (can start its Intent editor after S7)
- **Produces:** `apps/web` client rewritten against `contracts/api/control-plane.openapi.yaml`, Intent editor, operator-facing exposure of HOLD causes, unknown delivery and native-loss exposure, accessibility pass; removal of the last vocabulary allowlist entry
- **Master plan:** [S12](../master-plan.md#s12--web-plumbing-completion)

## Goal

The carried-over UI shell speaks only the product API contract, expresses the product in the
design's vocabulary (Intent, Session, Workstream, no imperative lifecycle), and shows the operator
what the specs insist must be visible: why a Workstream is held, an ambiguous delivery, native loss
exposure, external restrictions.

## Read first

1. [ADR 0002](../adr/0002-workstream-session-model.md) (what the UI may call a Session), [ADR 0003 §Consequences](../adr/0003-reconciliation-over-state.md) (absence from the workset proves nothing)
2. [000 §Results](../specs/reconciliation/000_taxonomy.md#results) (HOLD semantics), [006 `CAPS-004`](../specs/reconciliation/006_capabilities.md), [engine: Prompt delivery](../specs/reconciliation/engine.md#prompt-delivery-and-context-creation) (`prompt_delivery_unknown` visible to the user), [continuity: loss exposure](../specs/reconciliation/continuity.md#current-native-proof-and-loss-exposure)
3. [AGENTS.md trust boundaries](../../AGENTS.md) (browser input selects reviewed public values only)
4. `apps/web/README.md`, the archived `apps/web/DECISION.md` rationale (no framework, no bundler), `apps/web/test/client-boot.test.ts` header
5. Field findings [§6](../field-findings.md#6-methodological-lessons) (the boot test story: never soften it into an allow-list)

## Before coding

- The product API must be complete for the flows below; add missing endpoints to
  `contracts/api/control-plane.openapi.yaml` in the owning slices rather than inventing them here.
  Needed: catalogue read (harness ids, models, efforts, capability ids as reviewed public values),
  Intent read/write (S2), feed and items (S4), permission decisions (S4), reconciliation status view
  (operational, S2), Session list with provenance (S3), loss exposure (S9).
- Decide the status vocabulary the UI shows. It derives from the operational view and fresh
  projections: "converged", "reconciling: <rule id and blocking cause>", "held: <cause>",
  "delivery unknown", "restricted by organization policy". It never shows a persisted lifecycle
  phase, because none exists.

## Deliverables

```text
apps/web/src/client/api.ts          rewritten by hand from the OpenAPI contract; no legacy function remains
apps/web/src/client/view-model.ts   Intent/Session/Workstream model; status derivation
apps/web/src/client/app.ts          Intent editor (harness, capabilities as flat named set, model, effort); status surfaces; permission decisions; loss exposure banner
apps/web/test/*                     view-model tests updated; boot test unchanged in spirit; new tests for status derivation
scripts/check-forbidden-vocabulary.mjs   ALLOWLIST emptied
apps/web/README.md                  updated
```

## Work plan

### Step 1 — Contract-driven client

Rewrite `api.ts` function by function from the OpenAPI file; delete everything that has no server
side (activate/suspend/close/probe). Remove `liveSessionRuntime` and empty the vocabulary allowlist;
`npm run check` must pass with zero tolerated hits.

### Step 2 — Intent editor

Selections come from the catalogue endpoint only: harness, capability set (flat, named, multi-select),
model, effort valid for the model. Submitting sends the **complete** Intent with an
`Idempotency-Key`; a 409 conflict or 422 invalid is shown with the Problem `detail`. Power is a
toggle producing a complete Intent that retains selections when turning off.

### Step 3 — Status surfaces

From the operational view and projections: reconciling with rule id and blocking cause; `CAPS-004`
HOLD shows the external restriction and its remediation text; `prompt_delivery_unknown` shows the
ambiguous command with the explicit warning about duplicated external effects and the linked-retry
affordance only once resolved; `CONT-012` loss exposure banner (facts since the old Anchor may be
unrecoverable natively). A converged Workstream shows "converged as of <observation time>", never
"ready".

### Step 4 — Permissions and callbacks

Permission interactions projected in S4 get their decision UI; the decision posts to the API and the
UI shows the ACP outcome that came back, not the click.

### Step 5 — Accessibility and boot

Keyboard and screen-reader pass on the new surfaces (native semantics, labeled controls, focus
management on the composer). The boot test keeps asserting that `app.js` evaluates end to end
against hostile empty responses; do not add an allow-list of expected errors (findings §6, and the
test's own header).

## Reuse

The shell itself is the reused artifact. Nothing else.

## Definition of done

- [x] `api.ts` matches the contract; the vocabulary allowlist is EMPTY (`npm run check`: 0 tolerated);
      no imperative lifecycle call remains — activate/suspend/close/probe are gone rather than stubbed,
      and `Session.phase` with them.
- [x] Intent editor sends complete Intents from catalogue values only (`GET /v1/catalogue`, the same
      view the server validates against).
- [x] Status, HOLD cause, unknown delivery and loss exposure visible; `deriveStatus` and
      `lossExposureBanner` are covered by view-model tests, including that `converged` never says
      "ready" and that an ambiguous delivery outranks everything and blocks sending.
- [x] Permission decisions round-trip: the pending list now carries the options the AGENT offered
      (it published only ids before, which no UI could render), the control plane refuses an
      `optionId` outside that set, and the surface reports `sent` until the response frame has been
      journaled and projected — a click is never shown as an outcome.
- [x] Boot, markdown and view-model tests green — the boot test still evaluates the whole bundle
      against hostile empty responses, with no allow-list of expected errors, and it CAUGHT the
      catalogue read storing an empty body verbatim.
- [~] Accessibility: the pass found and fixed four real defects — an identity control claiming
      `role="button"` that answered no key, menus with no Escape and no focus return, selector
      triggers with no `aria-expanded`, and controls whose focus ring the shell never drew. The
      banner is `role="status" aria-live="polite"` and each permission request is a labelled
      `role="group"`. A screen-reader pass is NOT recorded: it needs a person with a screen reader,
      and correct markup is not evidence of it.
- [x] Master plan S12 marked done — the slice is complete; the deployment-level open item shared
      with S8–S11 remains, and belongs to none of them.

## Report

List the endpoints consumed, the status vocabulary and its derivation rules, and any place where
the UI had to hide information for presentation (allowed) versus persistence (never).

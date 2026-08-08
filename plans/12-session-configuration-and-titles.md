# P12 — Session configuration before launch, and real Workstream titles

- **Status:** implemented; live rollout pending the deployment merge
- **Dependencies:** P03, P05, P08, P09, P10
- **Primary paths:** `contracts/database`, `contracts/openapi/product-api.yaml`,
  `packages/store-pg`, `packages/acp`, `apps/web`

## Why

Two defects reported live on 2026-08-07, both of them the same shape: a fact the harness owns is
only ever readable while a Session Runtime is running, so the product surface goes blank the moment
one is not.

1. **The model/effort selector is dead before a Session exists and unusable once the Runtime is
   reaped.** ACP config options are advertised in the `session/new` response, so the composer of a
   brand-new conversation has nothing to show (the button renders `disabled`), and a suspended
   Session answers `PUT /v1/sessions/{id}/config-options/{id}` with `409 runtime_unavailable`. The
   operator can therefore only choose a model in the narrow window where a Pod happens to be alive.
2. **Every Workstream is called `Untitled`.** `title` is written as the literal `'Untitled'` at
   creation and only a manual rename ever changes it — while both shipped Agents already publish a
   real, self-maintained title over ACP (`session_info_update`), which the projector already stores
   and nothing ever reads.

## Decisions (operator, 2026-08-07)

- The pre-launch option list is a **memo of what the harness itself advertised** — never a curated
  product list (docs/specs/04 "Agent-advertised modes and configuration options are authoritative.
  The product MAY cache them for selection").
- When no memo exists for an Agent (a harness never launched at this runtime-definition version),
  the product **runs it empty** — materializes a Runtime, performs `initialize` + `session/new`,
  reads the advertised options and tears it down — rather than inventing a list or leaving the
  selector dead.
- Changing model/effort on a **suspended** Session records the intent durably and applies it at the
  next wake. No Pod is started for a setting alone, and no error is shown.

## Deliverables

- `product.agent_config_catalogue`: last-advertised option set per (Agent, runtime definition
  version), values only — no `currentValue` from anyone's Session.
- `product.session_config_intent`: the operator's desired configuration per Session, applied at
  bootstrap and re-applied at resume.
- An empty-run probe that fills the catalogue for an Agent that has never been launched.
- `GET /v1/agents/{agentId}/config-options` + `POST .../config-options/probe`.
- `configOptions` accepted on `CreateWorkstreamRequest`/`OpenSessionRequest`.
- `PUT /v1/sessions/{id}/config-options/{optionId}` accepts a change with no live Runtime.
- Workstream title derived from the Agent's own `session_info_update`, with the first user message
  as the floor and a manual rename always winning.

## Tasks

- [x] Migration: catalogue + intent tables, role grants, and a backfill of the catalogue from the
  existing journal so the shipped Agents need no probe.
- [x] `packages/store-pg`: catalogue and intent read/write, plus the effective-title read.
- [x] `packages/acp`: return the `session/new` option set from `bootstrapSession`; add a probe that
  performs `initialize` + `session/new` on a raw (non-journaled) stream.
- [x] `apps/web`: catalogue service + probe runner (single-flight), intent application at bootstrap
  and resume, endpoints, and the client selector/draft work.
- [x] Title floor at creation, effective title in the read model.
- [x] Tests: real Postgres for the store, real HTTP + fake controller/agent for the web paths, and
  view-model tests for the client derivations.
- [ ] Live verification on the cluster: both defects reproduced, then shown fixed. *(the migration
  is applied to the production database and the image is built and pushed; the rollout itself waits
  on the deployment merge — infra-k8s#115, which the branch ruleset reserves to the operator.)*

## Required tests

- Catalogue memo written from a real `session/new` response; `currentValue` never stored.
- Probe fills the catalogue for an Agent with no memo, and its Runtime is torn down afterwards.
- A second concurrent probe for the same Agent does not start a second Runtime.
- Create with `configOptions` → the values are really sent to the Agent before the first prompt.
- Config change with no live Runtime → recorded, no error, applied at the next activation.
- Config change with a live Runtime → still a real `session/set_config_option`, response authoritative.
- Title: floor from the first message; Agent `session_info_update` overrides it; a manual rename
  survives a later Agent title.

## Non-goals

- No product-owned model list, and no `model`/`effort` columns anywhere (docs/specs/04).
- No probe on a schedule: it runs once per (Agent, runtime definition version), on demand.
- No mode (`session/set_mode`) surface changes — modes already work through their own endpoint.

## Exit criteria

- The model and effort selectors are usable in a brand-new conversation, in a live conversation and
  in a suspended one.
- A conversation names itself after its first turn, and a renamed one keeps its name.
- Verified live on the cluster, not only in tests.

## Evidence

**2026-08-07/08 — implementation, tests and a real browser.**

- 413 tests green on a clean checkout (`npm test`), all against real Postgres, a real HTTP server
  and a real fake ACP Agent over a real WebSocket. The new ones prove, among others: both choices
  made in the composer reach the Agent BEFORE the first prompt (asserted on journal order, not on
  a mock's call log); a change made while the Session is suspended answers 202 and is really
  delivered by the resume; two concurrent empty runs start ONE Runtime and give its Pod back; a
  refused value is not re-asserted for ever; the Agent's own title overrides the first-message
  floor and a manual rename outranks both.
- **Real Chromium against the real client bundle** (the one artefact nothing else loads), driving
  the local build end to end: on a brand-new conversation the model button is enabled and offers
  `Default (recommended) / Sonnet / Opus` — the harness's own list, with nothing running — the
  effort rail moves with the arrow keys, the choice survives into the launched Session (`Opus`
  reported by the live Agent afterwards), the conversation renames itself to its Agent's title in
  both the sidebar and the topbar, and a mid-conversation switch to `Sonnet` works. Zero page
  errors. Screenshots kept out of the repo (session scratchpad).
- **Production database migrated**: `008-session-configuration.sql` applied to `agora`. Its
  backfill found **5 real advertisements already in the journal** — `claude-code` at three
  runtime-definition versions and `codex` at two — so neither shipped Agent needs an empty run to
  offer a model list. The recorded `claude-code` set is its genuine one (`mode`, `model`, `effort`,
  with Claude Code's own descriptions), `currentValue` stripped.
- Image `ghcr.io/arnaultbretagne/agora-web@sha256:298ae4c56fe2b519a5c8a30b77f6ec63d5a79a48bc07266ba48ea07a42fa370f`
  built and pushed; deployment change in infra-k8s#115.

**Not yet done:** the rollout, and therefore the live proof against the real `claude-code` harness
in the cluster. It waits on infra-k8s#115 being merged, which the `agents-propose-only` ruleset
deliberately reserves to the operator.

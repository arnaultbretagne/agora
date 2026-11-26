# Preview

Contract to implement: a pull request's server and client run as a preview, with nothing of production.
Written against infra-k8s's previews (its ADR 0017, v4, and its amendment of 2026-10-27): a catalogue entry
with `source: main`, `data: empty`, `internet: false`; a namespace running under Kata; a browser gate and a
gateway gate in front of the workload.

**A preview is the image of the pull request's commit, started with `PREVIEW=true` and its database's URL
alone. Its sandboxes run the mock agent in its own container, its conversations are the client's fixtures,
and it reaches nothing but its database.**

## The image

| Element | Rule |
| --- | --- |
| Published | By `.github/workflows/preview.yml`, for a pull request whose branch is in `arnaultbretagne/agora` and which carries the label `preview`: when the label is set, then at each push while it stays. The image of the pull request's head commit, tried as a preview (V4 to V6) before it is published. |
| Name | `ghcr.io/arnaultbretagne/agora-server:<the head commit's full SHA>`. The package is public. |
| Not published | For a pull request without the label, one from a fork, and on `labeled` for another label. A push to a branch publishes no image (`ci.yml`): the base branch does, and a run by hand. |

## The configuration

| Variable | Rule |
| --- | --- |
| `PREVIEW` | `true`: the server starts as a preview. Any other value, or none: as in production, which needs no variable of this document. |
| `PREVIEW_DATABASE_URL` | Required. The URL of an empty PostgreSQL 17 database and of the login that owns it. Missing: the server exits 1, `PREVIEW_DATABASE_URL is required`. |
| Production's | `SANDBOX_NAMESPACE`, `SIGNING_KEY_FILE`, `KUBE_API`, `KUBE_TOKEN_FILE`, `LOG_WRITER_URL`, `LOG_PROJECTOR_URL`, `LOG_ANCHORS_URL`, `FILES_ENDPOINT`, `FILES_BUCKET`, `FILES_ACCESS_KEY_ID`, `FILES_SECRET_ACCESS_KEY`, `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, `OFFERED_PROFILES`, `POD_IP`, `GATEWAY_CA_FILE`, `GITHUB_TEST_API`, `IDENTITY_ISSUER`, `IDENTITY_AUDIENCE`, `IDENTITY_TOKENS_DIR`, and `IDENTITY` other than `none` (a preview's identity is `none`, `log.md`, "Identity"). One of them set: the server exits 1 before listening, `PREVIEW excludes` and their names. |
| The others | `PORT`, `MAX_ACTIVE`, `LEASE_SECONDS`, `CEILING_SECONDS`, `RENEW_SECONDS`, `APPROVAL_SECONDS`, `TEST_ROUTES` as in production. |

## The database

| Element | Rule |
| --- | --- |
| Its login | The database's owner, which needs no other right: no `CREATEROLE`, no superuser. Every connection of the log uses it; its runtime roles' boundaries are not checked. |
| The schema | At every start, as that owner, `packages/log/sql/001.sql` without its runtime roles: their creation, and what follows its first `REVOKE ALL ON workstreams`. A schema whose part from there holds anything but grants and revocations is refused, `owner_schema_unknown`, and the server does not start. |
| Ownership | As in production (`log.md`, "Database ownership"): a second server on the same database exits, `dispatch_owner_exists`. |

## The conversations

| Element | Rule |
| --- | --- |
| When | At a start on a database that holds no Workstream, before the server listens; written once, in one transaction. The output says `- preview: 15 conversations written`. A start on a database holding one writes none. |
| Which | `apps/web/test/fixtures/mock.json` cut at each of its marks — `opened`, `permissionPending`, `inProgress`, `uncertain`, `lost`, `ended`, `restored`, `stopped`: its entries up to that position — `claude-code.json`, `codex.json`, `opencode.json` whole, and `antigravity.json` whole once it is captured — until then there is none, and nothing stands in for it; `delegation.json`, a delegator and its delegate: the delegate's last message come into a command of its delegator's, then a `send_message` on which its agent waits on a permission Agora has told the delegator of (`delegation.md`, "Requests"); and `forms.json`, two conversations whose agent waits on a form (`assistant-ui.md`, "Forms") — Claude Code's AskUserQuestion with one question, and with two. Fifteen Workstreams, fourteen in the list: the delegate is a sub-stream of its delegator. |
| Captured | A real harness's history is a tool-heavy task played on a deployed server with `TEST_ROUTES` and that harness's pool, every permission allowed: `node apps/web/scripts/capture.real.ts <server> <pool> <harness>` writes `apps/web/test/fixtures/<harness>.json`. A real harness spends its subscription. antigravity's waits for the cluster's Google login and the gateway's route (`credentials.md`, "Antigravity"); every other harness's fixture must be there, or the start fails. |
| How | Each a Workstream of its own, identified from its name — the delegation's two and the forms' by the ids they were captured with, which the delegation's entries name —; its entries as recorded, their times included, their connections renamed with the Workstream. No command, session or anchor row: no execution of theirs is followed, and their views are projected from their entries at the start. |
| Owner | The shared owner below. |
| Use | To be looked at. In one whose history ends with its execution not ended, a message is refused `stale_execution` and a new execution `execution_active`: no execution of theirs is followed. |

## Identity

| Element | Rule |
| --- | --- |
| The gates | The browser gate's `X-Forwarded-Email`, and the gateway gate's: `x-agora-gate: gateway`, `Authorization: Basic client-<id>:none`, `X-Forwarded-Email: client-<id>`. Both served alike. |
| Shared owner | Every caller a gate names owns the Workstreams of one owner, `00000000-0000-4000-8000-000000000000`, the client's own when no proxy names anyone: what one gate made is listed through the other. `GET /api/account` gives the email the gate passed. |

## The sandboxes

| Element | Rule |
| --- | --- |
| The pool | One, `mock`, harness `mock`, `agora.bretagne.dev/session-config: mode=full-access`, not `testing`: the screen offers it. |
| A claim | Bound at once to a sandbox of its own: a bridge on the loopback, the mock agent as its adapter, its home a new directory under `/tmp`; the adapter's environment holds only `HOME`, `PATH` and `NODE_NO_WARNINGS`. |
| Its deadline | The sandbox ends as a Pod at its SIGTERM: the bridge pushes its native files to the server's anchor receiver, with a token only that sandbox was given; its home is removed, then its claim. |
| The keys | The bridges' signing key is made at the start; no credential is attached (no gateway). |
| Files | Kept in the server's memory: a new process starts without the files and anchors of the one before. |
| Reached | Nothing outside the process: no Kubernetes API, no gateway, no bucket, no Internet. |

## The offer

| Element | Rule |
| --- | --- |
| What is offered | `GET /api/config` gives `credentials` with `proxy` null, no `profiles` and no `base`, and `offered` fixed: `internet`, `github:example/app:write`, `github:example/docs:write`, `github:example/site:read`, `vault:write`, `kubernetes:read`, `agora:delegate` — what each entry of the access picker folds (`assistant-ui.md`, "Access"); the repositories invented. Never `agora:read` nor `previews`, every execution's already (`credentials.md`, "Default profiles"), nor a harness's base profile, `anthropic`, `zai`, `chatgpt` or `antigravity`, a pool's alone (`credentials.md`, "Base profiles"). |
| What it gives | Nothing. The offer is said by the configuration alone: no key signs a token for it, no execution is handed a credential, and an execution created or scoped with any of them reaches no more than one with none. A Create's and a Scope's profiles are checked as without a gateway (`credentials.md`): recorded, never granted. |
| Production | Unchanged: without `PREVIEW=true`, `GET /api/config` says what the gateway's signer offers, `OFFERED_PROFILES`, as before; with it, `GATEWAY_PROXY` and `OFFERED_PROFILES` still stop the server ("The configuration"). |

## The limits

| Element | Rule |
| --- | --- |
| What `GET /api/limits` answers | Three invented subscriptions (`credentials.md`, "Limits"), whatever the pools: `anthropic`, no plan, its 5-hour window 42 % used and starting again in 2 h 10 min, its week 68 % in 3 days 4 h, read at the request; `chatgpt`, plan `pro`, 12 % in 4 h 25 min and 88 % in 1 day 6 h, read at the request; `zai`, plan `lite`, 30 % in 1 h 45 min and 55 % in 5 days, `stale`, read 40 minutes before the request, `error` `api.z.ai answered 503`. Each reset counted from the request. |
| What it reads | Nothing: no provider, no gateway. |
| Production | Unchanged: without `PREVIEW=true`, the limits are read through the gateway as `credentials.md` says, and none without it. |

## Acceptance cases

| Case | Scenario | Expected |
| --- | --- | --- |
| V1 | A pull request from a branch of the repository, labelled `preview`; a push while it is labelled; a pull request without the label; one from a fork | `agora-server:<full SHA>` of its head published once the label is set, then of the pushed commit, each after V4 to V6 passed on it; no image for the pull request without the label, nor for the fork. |
| V2 | A preview started without `PREVIEW_DATABASE_URL`; then with it and, in turn, `SANDBOX_NAMESPACE`, `SIGNING_KEY_FILE`, `LOG_WRITER_URL`, `FILES_ACCESS_KEY_ID`, `GATEWAY_PROXY`, `GRANTS_KEY_FILE` | Exit 1, `PREVIEW_DATABASE_URL is required`; each time exit 1, `PREVIEW excludes` and that name, never listening. |
| V3 | A first start on an empty database whose one login owns it and may create no role; the list through each gate; a second start | `15 conversations written`; fourteen rows through each gate, the same; eleven of harness `mock`, whose states are `ended`, `interrupted`, `lost`, `ready` and `stopped`; one each of `claude-code`, `codex` and `opencode`. The second start writes none and lists the same fourteen. |
| V4 | Behind the browser gate's headers: `GET /`, then in a browser the client, the Mock agent picked, a message sent, then `/sleep 4` | `200`, the client's page; at least twelve conversations listed before anything is done; `Echo #1:` and the message; `… second 1/4` shown while the turn runs, `Slept 4 s.` not yet, then shown without a reload; the new conversation listed, harness `mock`. |
| V5 | The same behind the gateway gate's headers; the list through the browser gate's | As V4; the conversation the gateway gate made listed through the browser gate. |
| V6 | The image in a network that lets only its database through, a read-only root, `/tmp` on a tmpfs, every capability dropped, given `PREVIEW=true` and its database's URL alone | Its database reached; `github.com`, `1.1.1.1` and `kubernetes.default.svc` not; no ServiceAccount token, no `KUBERNETES_SERVICE_HOST`, none of production's variables; its one network internal; V4 and V5 pass against it. |
| V7 | On a database whose one login owns it and may create no role: a role created on that login; its owner's part of the schema, twice; the log on that login; the same login as runtime logins; a roles part holding a table, and a schema without one | The role refused, `42501`; the owner's part applied twice, every table and `pg_trgm`, none of the runtime roles named; a Workstream written and read; `invalid_runtime_role`; `owner_schema_unknown` twice. |
| V8 | Behind the browser gate's headers, in a browser: the delegation's delegator opened, its line unfolded; then a draft, the Mock agent picked, `/permission` sent, then Allow | Its row "waiting for you"; the delegate's last message folded with a command, "1 command, 1 message"; Agora's message saying the request, an option `allow-once: Allow (allow_once)`; the delegate's two lines — its `spawn_agent`, its `send_message` — and its row "waiting for you". Then the card, the new row "waiting for you"; once allowed, `Permission: allow-once.`, no card, the row waiting no more. |
| V9 | Behind the browser gate's headers, in a browser: the two forms' conversations opened; then a draft, the Mock agent picked, `/question` sent, an option chosen, Answer | Each row "waiting for you"; the first, its select box pending, the question and its options; the second, its Question Flow pending, "1 of 2". Then the box; answered, the agent given the option, the box a receipt. |
| V10 | Behind the browser gate's headers: `GET /api/config`; then in a browser, a draft, the Mock agent picked, the access picker opened, GitHub ticked | `proxy` null, `offered` the seven profiles of "The offer", no base profile; the key on the composer, its menu listing Internet, GitHub — `example/app, example/docs, example/site (read)` under it —, vault, k8s, agora, one line each, no harness's or model's service; the key then named "Internet, GitHub". |
| V11 | The fixtures without `antigravity.json`; then with one; then without `opencode.json` | Fifteen conversations, fourteen of them listed, none of `antigravity`; then sixteen, `antigravity` a Workstream of its own with the fixture's entries; then the conversations refused, the missing fixture named. |
| V12 | Behind the browser gate's headers: `GET /api/limits`; then in a browser, the client, the gauge in the header clicked | `anthropic`, `chatgpt` and `zai` as "The limits" says, their resets counted from the request; the gauge, opened: Claude, ChatGPT `pro` and z.ai `lite`, each with "5-hour" and "Weekly", z.ai's "Not updated since". |

## To be specified

| Subject | Open question |
| --- | --- |
| Files | Whether a preview's files and anchors should outlive its process, kept in its database. |

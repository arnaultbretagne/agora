# Preview

The evidence behind the acceptance cases of `specs/preview.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-16 | `42b7ab6` | local | CI's `check` job on the pull request (`ci.yml`, run 43891294091): GitHub's `ubuntu-latest`, Node 24, the `postgres:17` service, `npm run check`, all green. V2 to V5 on the server's process from the repository, `PREVIEW=true`, each on an empty database whose one login owns it, `NOCREATEROLE`; the client built, in Playwright's Chromium. |
| R2 | 2026-11-16 | `42b7ab6` | local | `preview.yml`, run 43891294099, on the pull request labelled `preview`: the server's image built from the head commit, then `scripts/try-preview.ts` — a Docker network created `--internal`, `postgres:17` beside it with a login `agora` owning the database `agora`, `NOCREATEROLE`; the image with `--read-only`, `/tmp` on a tmpfs, `--cap-drop ALL`, `no-new-privileges`, given `PREVIEW` and `PREVIEW_DATABASE_URL` alone; the cases through a relay on the runner's loopback to the container's address. Then the image published. |
| R3 | 2026-11-16 | `8363d98` | local | `preview.yml` on the same pull request: its label removed at 15:10:58 UTC, the commit pushed (run 43894688906), then the label set again at 15:17:46 (run 43894795904, created 15:17:48, no push between). As R2 otherwise. CI's `check` on that commit green (run 43894688936). |
| R4 | 2026-11-16 | `986f1a5` | local | `npm run check` on g4, all green: Node 24.20.0, PostgreSQL 17.12, each test on a database of its own; V2 to V5 and V8 on the server's process from the repository, `PREVIEW=true`, each on an empty database whose one login owns it, as R1; the conversations with the captured delegation (`apps/web/test/fixtures/delegation.json`). |
| R5 | 2026-11-16 | `70cfdc1` | local | `preview.yml`, run 43915132946, on pull request #214 labelled `preview`: the server's image built from the head commit and tried by `scripts/try-preview.ts`, as R2, its conversations with the captured delegation; then `ghcr.io/arnaultbretagne/agora-server:70cfdc1a85244d9dc275192b5e7df06d5190c7b4` published, `sha256:a8f3e9214c5b512b3ff657e282d48dee6e76463731f361f24a85f130cfb31f54`. CI's `check` on that commit green (runs 43915089724, push, and 43915117047, pull request). |
| R6 | 2026-11-16 | `2970cd7` | local | `npm run check`, with `npm run test:browser`, all green, on g4: Node 24.20.0, PostgreSQL 17.12, each test on a database of its own, Playwright's Chromium; the server started as a preview from the source, as R4, its conversations with the captured forms. |
| R7 | 2026-11-16 | `754f907` | local | `preview.yml`, run 43931922712, on pull request #215 labelled `preview`: the server's image built from the head commit and tried by `scripts/try-preview.ts`, as R5, its conversations with the captured forms; then `ghcr.io/arnaultbretagne/agora-server:754f907ed5707d8ddaa370ccca2a562c4f82ab28` published, `sha256:c33a1befbe199a73f9edd09af39b7d9e2f4fe7c5e14972c66dfca634e998675d`. CI's `check` on that commit green (run 43931810206, push). |
| R8 | 2026-11-16 | `3ae57a4` | local | `npm run check`, with `npm run test:browser`, on g4: Node 24.20.0, PostgreSQL 17.12, each test on a database of its own; the first pass stopped on L20 (`EADDRINUSE`: a port taken between its `freePort()` and the lab's listen, as R39 saw), the second all green, Playwright's Chromium; the server started as a preview from the source, as R6. |
| R9 | 2026-11-18 | `a6768ad` | local | `npm run check`, with `npm run test:browser`, on g4, as R44 of `client.md`: Node 24.20.0, PostgreSQL 17.12, each test on a database of its own, Playwright's Chromium; the server started as a preview from the source, as R8, its conversations with the delegation captured again by `scripts/capture.delegation.ts` — the delegate's last message come into a `/tool-open 6` of its delegator's, then a `send_message` asking the permission. |
| R10 | 2026-11-18 | `f5a3752` | local | `preview.yml`, run 44329646987, on pull request #219 labelled `preview`: the server's image built from the head commit and tried by `scripts/try-preview.ts`, as R7, its conversations with the delegation captured again; then `ghcr.io/arnaultbretagne/agora-server:f5a37527d3d6ea0f83dc92c4a07a969688038da2` published, `sha256:666aa12569b3e8b2fa263ee2fd860e9013aec2c417b269351c037fda0c2c8b7d`. Its first run, on `14b4cf4` (44328892553), failed V8: two lines now name the delegate, and the test's locator took one alone; fixed in the test. |
| R12 | 2026-11-20 | `3bc2451` | local | The `check` job of pull request #229 (GitHub Actions job 136569971272), all green — V6 skipped, no Docker there: Node 24, PostgreSQL 17 (`postgres:17`), Playwright's Chromium headless shell, on the merge of `main` with the access picker (#216). V10 against the preview server started in the job's own process, behind the browser gate's headers. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| V1 | — | local | R2 | partial | On a push while labelled: `ghcr.io/arnaultbretagne/agora-server:42b7ab6be72dabae20b346c5244f18c862609fd3` pushed after V4 to V6 passed, `sha256:4c4221f2a5922f1a440600a24d4b092aaa96ecab87fae96f024a05926fa2498a`, its manifest read anonymously, `200`. The two commits before it, pushed while labelled, failed the cases and have no image: `404`. |
| V1 | — | local | R3 | partial | Pushed without the label: the job skipped, `agora-server:8363d987919d91475d4f8c56ef38b88b5896ad7d` `404`. The label set: V4 to V6 passed, then that tag published, `sha256:d2c4b15ff8b0d13c05461eaca3e8be74776e14671c87158ead7c488c066d7c8d`, `200` anonymously. Not shown: a pull request from a fork. |
| V2 | — | local | R1 | proven | No database: exit 1, `PREVIEW_DATABASE_URL is required`. With it and each of `SANDBOX_NAMESPACE`, `SIGNING_KEY_FILE`, `LOG_WRITER_URL`, `FILES_ACCESS_KEY_ID`, `GATEWAY_PROXY`, `GRANTS_KEY_FILE`: exit 1, `PREVIEW excludes` that name, no `server ready`. |
| V3 | real: the server stopped, then started again on the same database | local | R1 | proven | `- preview: 11 conversations written`; eleven rows through each gate, the same ids; eight `mock`, states `ended`, `interrupted`, `lost`, `ready`, `stopped`; `claude-code`, `codex`, `opencode`. The second start: nothing written, the same eleven. |
| V4 | — | local | R1 | proven | `GET /` `200`, `text/html`, the client's root; eleven rows before anything; `Echo #1: Hello from the browser gate.`; `… second 1/4` with no `Slept 4 s.`, then `Slept 4 s.`; the row `mock`. |
| V4 | — | local | R2 | proven | The same against the image. |
| V5 | — | local | R1 | proven | As V4 through the gateway gate's headers; its conversation listed through the browser gate's. |
| V5 | — | local | R2 | proven | The same against the image. |
| V6 | — | local | R2 | proven | Its database reached; `github.com`, `1.1.1.1`, `kubernetes.default.svc` not; no `/var/run/secrets/kubernetes.io`, no `KUBERNETES_SERVICE_HOST`, none of the production variables checked; one network, internal. |
| V7 | — | local | R1 | proven | `CREATE ROLE` refused `42501`; the owner's part applied twice, the twelve tables and `pg_trgm`, no runtime role named; a Workstream written and read on `LogStore.owner`; the same login as runtime logins `invalid_runtime_role`; `owner_schema_unknown` for a table after the grants and for a schema without them. |
| V3 | real: the server stopped, then started again on the same database | local | R4 | proven | `- preview: 13 conversations written`; twelve rows through each gate, the same ids; nine `mock`, states `ended`, `interrupted`, `lost`, `ready`, `stopped`; `claude-code`, `codex`, `opencode`. The second start: nothing written, the same twelve. |
| V4 | — | local | R4 | proven | As R1, at least twelve rows before anything. |
| V5 | — | local | R4 | proven | As R1. |
| V8 | — | local | R4 | proven | The row `Ship the release notes` "waiting for you"; opened, Agora's message `it waits for an answer to its request <n>: a permission.` with `allow-once: Allow (allow_once)`; the delegate's line "waiting for you"; unfolded, its row "waiting for you". A draft, the Mock agent, `/permission`: the card, the new row "waiting for you"; Allow: `Permission: allow-once.`, the card gone, the row waiting no more. |
| V4 | — | local | R5 | proven | The same against the image, at least twelve rows before anything. |
| V5 | — | local | R5 | proven | The same against the image. |
| V6 | — | local | R5 | proven | As R2, against this image. |
| V8 | — | local | R5 | proven | The same against the image: the delegator `Ship the release notes` and its delegate "waiting for you", Agora's message naming the request; a live `/permission` waiting, then allowed through its card, waiting no more. |
| V3 | real: the server stopped, then started again on the same database | local | R6 | proven | `- preview: 15 conversations written`; fourteen rows through each gate, the same ids; eleven `mock`, states `ended`, `interrupted`, `lost`, `ready`, `stopped`; `claude-code`, `codex`, `opencode`. The second start: nothing written, the same fourteen. |
| V4 | — | local | R6 | proven | As R4, at least fourteen rows before anything is done. |
| V5 | — | local | R6 | proven | As R4. |
| V8 | — | local | R6 | proven | As R4. |
| V9 | — | local | R6 | proven | `Pick the service's database` "waiting for you": its select box pending, the question, `PostgreSQL`, `SQLite`; `Plan the release checks` "waiting for you": its Question Flow pending, "1 of 2". A draft, the Mock agent, `/question`: the box; `PostgreSQL`, Answer: `Elicitation: accept {"question_0":"PostgreSQL"}.`, the box `answered`. |
| V4 | — | local | R7 | proven | As R5, against the image: at least fourteen conversations listed. |
| V5 | — | local | R7 | proven | As R5. |
| V6 | — | local | R7 | proven | As R5, against this image. |
| V8 | — | local | R7 | proven | As R5. |
| V9 | — | local | R7 | proven | The same as R6 against the image: the two forms' conversations "waiting for you", the select box and the Question Flow pending; a live `/question` answered through its box, `Elicitation: accept {"question_0":"PostgreSQL"}.`. |
| V3 | real: the server stopped, then started again on the same database | local | R8 | proven | As R6. |
| V4 | — | local | R8 | proven | As R6. |
| V5 | — | local | R8 | proven | As R6. |
| V8 | — | local | R8 | proven | As R6. |
| V9 | — | local | R8 | proven | As R6, the receipt shown once the projection gives the answer. |
| V3 | real: the server stopped, then started again on the same database | local | R9 | proven | As R8. |
| V4 | — | local | R9 | proven | As R8. |
| V5 | — | local | R9 | proven | As R8. |
| V8 | — | local | R9 | proven | The row `Ship the release notes` "waiting for you"; its fold `1 command, 1 message`; Agora's message the line `From Agora · …`, opened: `it waits for an answer to its request <n>: a permission.` with `allow-once: Allow (allow_once)`; two delegate lines "waiting for you"; unfolded, its row "waiting for you". A draft, the live `/permission` allowed through its card, waiting no more. |
| V9 | — | local | R9 | proven | As R8. |
| V4 | — | local | R10 | proven | As R7. |
| V5 | — | local | R10 | proven | As R7. |
| V6 | — | local | R10 | proven | As R7. |
| V8 | — | local | R10 | proven | As R9, against the image. |
| V9 | — | local | R10 | proven | As R7. |
| V10 | — | local | R12 | proven | `proxy` null; `offered` `internet`, `zai`, `chatgpt`, `github:example/app:write`, `github:example/docs:write`, `github:example/site:read`, `vault:write`, `kubernetes:read`, `agora:delegate`; the menu Internet, z.ai, ChatGPT, GitHub with `example/app, example/docs, example/site (read)`, vault, k8s, agora; GitHub ticked, the key "Internet, GitHub". |

## Not covered

| Failure | Issue |
| --- | --- |
| A preview in the cluster, under Kata, behind its real gates: its catalogue entry is infra-k8s's | — |
| A pull request from a fork: no run shows that it publishes nothing | — |

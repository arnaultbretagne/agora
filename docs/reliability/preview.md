# Preview

The evidence behind the acceptance cases of `specs/preview.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-16 | `42b7ab6` | local | CI's `check` job on the pull request (`ci.yml`, run 43891294091): GitHub's `ubuntu-latest`, Node 24, the `postgres:17` service, `npm run check`, all green. V2 to V5 on the server's process from the repository, `PREVIEW=true`, each on an empty database whose one login owns it, `NOCREATEROLE`; the client built, in Playwright's Chromium. |
| R2 | 2026-11-16 | `42b7ab6` | local | `preview.yml`, run 43891294099, on the pull request labelled `preview`: the server's image built from the head commit, then `scripts/try-preview.ts` — a Docker network created `--internal`, `postgres:17` beside it with a login `agora` owning the database `agora`, `NOCREATEROLE`; the image with `--read-only`, `/tmp` on a tmpfs, `--cap-drop ALL`, `no-new-privileges`, given `PREVIEW` and `PREVIEW_DATABASE_URL` alone; the cases through a relay on the runner's loopback to the container's address. Then the image published. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| V1 | — | local | R2 | partial | On a push while labelled: `ghcr.io/arnaultbretagne/agora-server:42b7ab6be72dabae20b346c5244f18c862609fd3` pushed after V4 to V6 passed, `sha256:4c4221f2a5922f1a440600a24d4b092aaa96ecab87fae96f024a05926fa2498a`, its manifest read anonymously, `200`. The two commits before it, pushed while labelled, failed the cases and have no image: `404`. Not shown by this run: the label set, the pull request without it, a fork. |
| V2 | — | local | R1 | proven | No database: exit 1, `PREVIEW_DATABASE_URL is required`. With it and each of `SANDBOX_NAMESPACE`, `SIGNING_KEY_FILE`, `LOG_WRITER_URL`, `FILES_ACCESS_KEY_ID`, `GATEWAY_PROXY`, `GRANTS_KEY_FILE`: exit 1, `PREVIEW excludes` that name, no `server ready`. |
| V3 | real: the server stopped, then started again on the same database | local | R1 | proven | `- preview: 11 conversations written`; eleven rows through each gate, the same ids; eight `mock`, states `ended`, `interrupted`, `lost`, `ready`, `stopped`; `claude-code`, `codex`, `opencode`. The second start: nothing written, the same eleven. |
| V4 | — | local | R1 | proven | `GET /` `200`, `text/html`, the client's root; eleven rows before anything; `Echo #1: Hello from the browser gate.`; `… second 1/4` with no `Slept 4 s.`, then `Slept 4 s.`; the row `mock`. |
| V4 | — | local | R2 | proven | The same against the image. |
| V5 | — | local | R1 | proven | As V4 through the gateway gate's headers; its conversation listed through the browser gate's. |
| V5 | — | local | R2 | proven | The same against the image. |
| V6 | — | local | R2 | proven | Its database reached; `github.com`, `1.1.1.1`, `kubernetes.default.svc` not; no `/var/run/secrets/kubernetes.io`, no `KUBERNETES_SERVICE_HOST`, none of the production variables checked; one network, internal. |
| V7 | — | local | R1 | proven | `CREATE ROLE` refused `42501`; the owner's part applied twice, the twelve tables and `pg_trgm`, no runtime role named; a Workstream written and read on `LogStore.owner`; the same login as runtime logins `invalid_runtime_role`; `owner_schema_unknown` for a table after the grants and for a schema without them. |

## Not covered

| Failure | Issue |
| --- | --- |
| A preview in the cluster, under Kata, behind its real gates: its catalogue entry is infra-k8s's | — |
| A pull request from a fork: no run shows that it publishes nothing | — |

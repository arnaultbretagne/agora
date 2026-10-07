# Credentials

The evidence behind the acceptance cases of `specs/credentials.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R0 | 2026-09-29 | `609940e` | cluster | g4 under Kata, agentgateway 1.5.0, lab and harness images from that commit. A fine-grained PAT limited to two throwaway repos, with write access to both. `apps/lab/scripts/live-cases.ts`, where C1–C4 were cases 23–26. |
| R0g | 2026-09-28 to 29 | — | cluster | The gateway configuration deployed by infra-k8s; requests sent by hand straight to the gateway, outside the lab. |
| R1 | 2026-09-30 | `7afc4d7` | cluster, live | g4 under Kata, agentgateway 1.5.0, thin bridge images. GitHub cases against public stand-ins (`octocat/Hello-World`, `octocat/Spoon-Knife`, `github/linguist`) with the gateway's stand-in PAT. C3 billed, on `haiku`. |
| R2 | 2026-10-02 | `f240cd0` | cluster, live | g4 under Kata, Agent Sandbox v1.0.3. The lab `agora-lab@sha256:1973a988…` built from that commit, on the `agora` database (CloudNativePG, PostgreSQL 17.4); pools `agora-harness-mock@sha256:1a1cc63c…` and `agora-harness-claude-code@sha256:5f3bb480…` (claude-agent-acp 0.75.1). `apps/lab/scripts/live-cases.ts` from that commit, against the deployed lab. Deadline cases with a 60 s lease and the lab's renewal step (a third of the lease). agentgateway as deployed by infra-k8s. GitHub cases against the public stand-ins with the gateway's stand-in PAT. C3 billed, on `haiku`. |
| R3 | 2026-10-02 | `b8bbc95` | local | `npm run check`: Node 24.20.0, real bridges with the mock agent, FakeKube with warm Sandboxes, a real signer with a key of its own; PostgreSQL 17.11 for the log's tests. The gateway is not run: what it answers is not shown at this level. |
| R4 | 2026-10-02 | `76334b4` | cluster, live | g4 under Kata, Agent Sandbox v1.0.3. The lab `agora-lab@sha256:9dc72442…` built from that commit; the claude-code pool declaring `agora.bretagne.dev/base-profiles: anthropic`, the mock's nothing; harness images as in R2. `apps/lab/scripts/live-cases.ts` from `9b13107` (only the runner changed since), reading the bridges' and the gateway's logs and sending requests from a Pod through its bridge, as the operator. agentgateway as deployed by infra-k8s; GitHub cases against the public stand-ins. C13 billed, on `haiku`. |
| R5 | 2026-10-02 | `e96543a` | cluster | g4 under Kata. The lab `agora-lab@sha256:130368d1…` built from that commit; the gateway with the route `zai` and the operator's z.ai key (infra-k8s #180), restarted to load the route. `apps/lab/scripts/live-cases.ts` from that commit. |
| R6 | 2026-10-03 | `4b26f3c` | cluster | g4 under Kata. The lab `agora-lab@sha256:251558cc…` built from that commit; the gateway with the route `chatgpt` and the cluster's own ChatGPT session (Plus, its own device-code login), kept by `chatgpt-refresher` (infra-k8s #182), restarted to load the route. `apps/lab/scripts/live-cases.ts` from that commit. |
| R7 | 2026-10-03 | `05fbbb8` | cluster, live | g4 under Kata, Agent Sandbox v1.0.3. The server `agora-server@sha256:31c1d086…` built from that commit, in the namespace `agora` behind agora.bretagne.dev, on the `agora` database (CloudNativePG, PostgreSQL 17.4); the pools mock `1a1cc63c…`, claude-code `5f3bb480…`, opencode `5b7b6182…` and codex `0eae81a3…`, their warm Pods recreated for the server's anchor address. `apps/server/scripts/live-cases.ts` from that commit, all 34 cases in one run; C10 and C12–C16 refused `quota` there — the run's stopped executions count until their deadline — and were played again once no claim was left. C3 and C13 billed, on Anthropic. |
| R8 | 2026-10-03 | `0c75f9b` | local | `npm run check`: Node 24.20.0, real bridges with the mock agent, FakeKube, a real signer with a key of its own offering `github:owner/a:write` and `github:owner/b:read`; PostgreSQL 17.11 for the log's tests. The gateway is not run. |
| R9 | 2026-10-04 | `a2d4230` | cluster | g4 under Kata. The server `agora-server@sha256:0f3edc12…` built from `af896c7` (its inputs unchanged since), offering `github:arnaultbretagne/agora:write` and `github:arnaultbretagne/infra-k8s:write` (infra-k8s #200, #201); the claude-code pool `agora-harness-claude-code@sha256:6d3f437e…` built from that commit, with git 2.39.5, `GIT_SSL_CAINFO` and the git identity from the template (infra-k8s #204, #207); the gateway with the operator's fine-grained PAT on those two repositories (infra-k8s #202). An execution created over the API with `github:arnaultbretagne/agora:read`, git run in its sandbox by `kubectl exec` through its bridge, and a Scope sent over the API; no model call. |
| R10 | 2026-10-05 | `dfd3df9` | cluster | g4 under Kata. The server `agora-server@sha256:f6d5898e…` built from `3ec2f96`, in the namespace `agora`, offering `internet` (infra-k8s #211, #210); the mock pool `agora-harness-mock@sha256:632991c4…`; agentgateway 1.5.0 with the route `internet` and its egress limited to public IPv4 on 443 (infra-k8s #210), restarted to load the route. `apps/server/scripts/live-cases.ts` from that commit, through `kubectl port-forward`; no model call. |
| R11 | 2026-10-05 | `77ce4ee` | cluster | As R10; only C24's control changed in the runner. One case per run, each once the previous one's executions had ended (`quota`). |
| R12 | 2026-10-04 | `4261ef0` | local | `npm run check`: Node 24.20.0, real bridges with the mock agent and the stdio test adapter; tokens shaped like Agora's JWTs, with stand-in signatures, which the bridge never verifies. The gateway is not run. |
| R13 | 2026-10-06 | — | local | agentgateway 1.5.0 (release binary, checksum verified) on the configuration of infra-k8s `295a38c` (`gateway.yaml`, paths and ports rewritten), a throwaway CA and signing key, stand-in credentials; requests sent by hand through `CONNECT`, from `127.0.0.1` and from the host's own address. |
| R14 | 2026-10-06 | `112e214` | local | `npm run check`: Node 24.20.0, real bridges with the mock agent, FakeKube recording an address per Sandbox, a real signer with a key of its own; PostgreSQL 17.11 for the log's tests. The gateway is not run. |
| R15 | 2026-10-06 | `b4efc8e` | cluster, live | g4 under Kata. The server `agora-server@sha256:a1fd2998…` built from that commit (infra-k8s #214), signing every token with its Pod's address; the pools claude-code `0345a542…`, codex `e88bc2bb…`, opencode `44f3d8c2…` and mock `1b2bd57b…`, unchanged; agentgateway 1.5.0 with `jwt.ip == source.address` on all six routes (infra-k8s #213, `f512960`), restarted to load it. `apps/server/scripts/live-cases.ts` from that commit, through `kubectl port-forward`; for C29 and C30, the claims read in the warm Pods and requests sent from a mock Pod straight to the gateway, by `kubectl exec`, with tokens signed by the operator with Agora's key. |
| R16 | 2026-10-07 | `1d15818` | unit, local | `npm run check`, all green: Node 24.20.0; the providers' answers as each gave them on 2026-10-07, identifiers left out; for C37 a stand-in gateway (a `CONNECT` server) and a stand-in provider over TLS, its certificate made by OpenSSL for `api.anthropic.com`; a real signer with a key of its own; PostgreSQL 17.11 for C33. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| C1 | — | cluster | R1 | partial: the refusals are asserted non-zero, not exactly one | 503 from the bridge, one refusal counted. Before any credential is attached, the outbound attempts of the pool's Pod are refused too. |
| C1 | — | cluster | R2 | partial: the refusals are asserted non-zero, not exactly one | 503 from the bridge, one refusal counted. |
| C1 | — | cluster | R7 | partial: the refusals are asserted non-zero, not exactly one | 503 from the bridge, one refusal counted. |
| C2 | — | cluster | R1 | proven | 400 from Anthropic ("anthropic-version: header is required"): TLS accepted, Bearer set by the gateway; tunnel → 200. |
| C2 | — | cluster | R2 | proven | 400 from Anthropic ("anthropic-version: header is required"); tunnel → 200. |
| C2 | — | cluster | R7 | proven | The tunnel 200; Anthropic's 400 ("anthropic-version: header is required") behind it. |
| C2 | — | cluster | R10 | proven | Under the gateway's egress limited to public addresses: Anthropic's 400 ("anthropic-version: header is required"); tunnel → 200. |
| C2 | — | cluster | R15 | proven | Under the address binding: Anthropic's 400 ("anthropic-version: header is required"); tunnel → 200. |
| C3 | — | live | R1 | proven | "Paris." in 2.0 s, `end_turn`; seven tunnels to `api.anthropic.com:443`, last `CONNECT` response 200. |
| C3 | — | live | R2 | proven | "Paris." in 2.2 s; three tunnels to `api.anthropic.com:443`, last 200. |
| C3 | — | live | R7 | proven | "Paris." in 2.4 s; seven tunnels to `api.anthropic.com:443`, last 200. |
| C4 | — | cluster | R0 | partial: the gateway's decisions are asserted; GitHub's answers are observed | A read 200, write 201, push 200; B read 200, fetch 200; B write, B push, C and GraphQL 403 from the gateway. The created file exists on A only, checked in GitHub. |
| C4 | — | cluster | R1 | partial: the gateway's decisions are asserted; with stand-ins, no write can succeed | Permitted requests reach GitHub (401); B write, B push, C and GraphQL stop at the gateway (403). |
| C4 | — | cluster | R2 | partial: the gateway's decisions are asserted; with stand-ins, no write can succeed | Permitted requests reach GitHub (401); B write, B push, C and GraphQL stop at the gateway (403). |
| C4 | — | cluster | R7 | partial: the gateway's decisions are asserted; with stand-ins, no write can succeed | Permitted requests reach GitHub (401); B write, B push, C and GraphQL stop at the gateway (403). |
| C5 | — | cluster | R0g | partial: probed by hand, no test | 401 for a missing, an expired and a foreign JWT. |
| C6 | — | cluster | R0g | partial: probed by hand, no test | 403 for `..`, `.`, `%2e` and `%2f`. |
| C7 | — | cluster | R0g | partial: probed by hand, no test; the case was then a host with no route, before the `internet` route | 404. |
| C7 | — | cluster | R10 | proven | The mock with `anthropic` only: example.com "403 Forbidden — authorization failed". |
| C8 | — | local | R3 | partial: the gateway's answers (reach, 403) are not exercised; the 503 is inferred from no token attached | Every assertion held, in each of its two tests. |
| C8 | — | cluster | R4 | proven | A warm claude-code Pod, before any claim: Anthropic answers (400, the probe sends no `anthropic-version`), `api.github.com` 403 from the gateway, which logs `jwt.sub` `agora warm <Pod>`. A warm mock Pod: 503 from the bridge, no hand-over in its log. |
| C8 | — | cluster | R7 | proven | The claude-code warm Pod: Anthropic 400, GitHub 403 from the gateway, `jwt.sub` "agora warm …"; the mock's Pod: 503 from its bridge. |
| C8 | — | cluster | R15 | proven | Under the address binding: the claude-code warm Pod reaches Anthropic (400), GitHub 403 from the gateway, `jwt.sub` "agora warm …" → 400; the mock's Pod: 503 from its bridge. |
| C9 | — | local | R3 | partial: requests between the tokens are not exercised | Every assertion held (39.3 s). |
| C9 | — | cluster | R4 | proven | Renewed 604 s after the first token, 296 s before it ran out; 20 requests from the Pod meanwhile, one every 30 s, none refused. |
| C9 | — | cluster | R7 | proven | Renewed 600 s after the first token, 299 s before it ran out; 20 requests, none refused. |
| C10 | — | local | R3 | proven | Every assertion held, in each of its three tests (two in the log, one in the bridge). |
| C10 | — | cluster | R4 | partial: the warm token's tunnels closing is shown by the bridge's test only | The execution's token handed at 19:04:36.997, `initialize` dispatched 34 ms later. From the Pod, B reaches GitHub (401 with the stand-in PAT), C stops at the gateway (403); no request under the warm name after the hand-off. |
| C10 | — | cluster | R7 | partial: the warm token's tunnels closing is shown by the bridge's test only | The token at 09:29:53.851, `initialize` dispatched at .888; from the Pod B 401 (GitHub), C 403 (gateway); four requests under the execution's name, none warm after the hand-off. |
| C11 | simulated: stub, the warm token's signing held 1.5 s | local | R3 | proven | Every assertion held. |
| C12 | simulated: stub, the signer refusing | local | R3 | partial: no request refused for an expiry during the turn is not exercised | Every assertion held, in each of its three tests. |
| C12 | — | cluster | R4 | partial: the previous tunnels closing is shown by the bridge's test only | Token until 19:06:10 → 19:06:12, the new one handed 7 ms before the prompt left; the turn's request reached Anthropic (400) under the execution's name. |
| C12 | — | cluster | R7 | partial: the previous tunnels closing is shown by the bridge's test only | Renewed 6 ms before the prompt left; the gateway passed it on (400 from Anthropic). |
| C13 | — | live | R4 | proven | Session open in 1,809 ms on a warm Pod. The opening and one turn on `haiku`: 7 tunnels to `api.anthropic.com:443`, none refused over the Pod's life. |
| C13 | — | live | R7 | proven | Session open in 2,602 ms on a warm Pod; 7 tunnels, none refused over the Pod's life. |
| C14 | — | local | R3 | proven | Every assertion held. |
| C14 | — | cluster | R4 | proven | `unknown_profile`, nothing written. |
| C14 | — | cluster | R7 | proven | "unknown_profile", nothing written. |
| C15 | — | cluster | R5 | proven | 200 from z.ai, four models listed; the gateway's route `zai` answered 200 under the execution's name. |
| C15 | — | cluster | R7 | proven | 200, four models listed; route `default/zai`. |
| C15 | — | cluster | R10 | proven | Under the egress limited to public addresses: 200, four models listed; route `default/zai`. |
| C16 | — | cluster | R6 | proven | `codex/models`: 200 from ChatGPT with the session the gateway set, the sandbox's `chatgpt-account-id` removed; `/backend-api/conversations`: 403 from the gateway. |
| C16 | — | cluster | R7 | proven | `codex/models` 200, one model; conversations 403 from the gateway; route `default/chatgpt`. |
| C16 | — | cluster | R11 | proven | Under the egress limited to public addresses: `codex/models` 200, one model; conversations 403 from the gateway; route `default/chatgpt`. |
| C17 | — | local | R8 | partial: the previous tunnels closing is shown by the bridge's test only | At once, a token naming `anthropic` and `github:owner/a:read`, the bridge holding its expiry; none more at the next prompt. With no profile left: a token naming none at once, none at the next prompt. |
| C17 | — | cluster | R9 | partial: the token is inferred from the push accepted right after, not read | With `github:arnaultbretagne/agora:read`, `git push --dry-run`: 403 from the gateway. Scope to `:write` accepted, the view's `profiles` replaced; the same push two seconds later, no prompt in between: `* [new branch] HEAD -> test-agora-identity`, nothing created on GitHub. |
| C18 | — | local | R8 | proven | `turn_active` during `/sleep 3`; `profile_not_offered` for `github:owner/b:write`; `unknown_profile` for `dropbox:everything`; one token only, no Scope recorded. |
| C19 | simulated: stub, the signer refusing | local | R8 | proven | Accepted with no new token; the next prompt preceded by a token naming `github:owner/a:write`; the signer refusing again after another Scope: the prompt fails `credentials_refused`. |
| C20 | — | local | R8 | partial: `GET /api/config` is asserted by U34 (`client.md`, R7) | `github:owner/a:read`, then `github:owner/a:write` with `github:owner/b:read`, accepted; `github:owner/b:write` refused `profile_not_offered`, nothing written. |
| C21 | real: Agora stopped cleanly and started again | local | R8 | proven | A second token naming `anthropic` and `github:owner/b:read`, handed before the prompt after the restart was dispatched. |
| C22 | — | cluster | R9 | proven | With `github:arnaultbretagne/agora:read`: `git ls-remote` listed `design/agora-foundations` and `main`, no TLS error; `infra-k8s`, not granted: 403. In a warm Pod whose token names `anthropic` only: 403 from the gateway ("authorization failed"). The control, without `GIT_SSL_CAINFO`: "Problem with the SSL CA cert". A commit there: author and committer `Agora <agent@agora.bretagne.dev>`. |
| C23 | — | cluster | R10 | proven | `GET` "200 OK", `POST` "405 Method Not Allowed", both from example.com; the gateway logged route `default/internet` → 200. |
| C23 | — | cluster | R15 | proven | Under the address binding: `GET` "200 OK", `POST` "405 Method Not Allowed" from example.com; route `default/internet` → 200. |
| C24 | — | cluster | R11 | proven | `internet` alone: `api.anthropic.com`, `api.z.ai`, `chatgpt.com`, `api.github.com` and `github.com` 403 from the gateway; with `github:octocat/Hello-World:read` added, GitHub "200 OK". |
| C24 | — | cluster | R15 | proven | Under the address binding: the five hosts with a credential 403 from the gateway with `internet` alone; with `github:octocat/Hello-World:read` added, GitHub "200 OK". |
| C25 | — | cluster | R11 | proven | `10.10.20.1.nip.io`: "503 — upstream call failed: Connect: deadline has elapsed", after 10 s; `10.10.20.1`: TLS "alert access denied"; example.com "200 OK". |
| C26 | — | cluster | R11 | proven | "CONNECT example.com:8443 refused by the proxy: 404". |
| C27 | — | local | R12 | proven | Every assertion held. |
| C28 | — | local | R12 | proven | Every assertion held, the control's too. |
| C29 | — | local | R14 | proven | The warm token's `ip` and the execution's are the addresses their Sandboxes record (`10.244.0.77`, `10.244.0.78`); the signer refused an empty address, a Pod's name and `10.244.0`. |
| C29 | — | cluster | R15 | proven | Within seconds of the new server's start, the warm tokens of claude-code, codex and opencode named their Pods' addresses (`10.244.0.228`, `10.244.0.91`, `10.244.0.49`), as their Sandboxes record them; the mock Pods, with no base profile, got none. |
| C30 | — | local | R13 | partial: probed by hand, no test; the sandboxes' addresses not exercised | `internet`: a token naming `127.0.0.1`, from there, 200; the same from `10.10.20.10`, 403; one naming `10.10.20.10`, from there, 200; with no `ip`, 403. Anthropic's route: a token naming `127.0.0.1`, from there, reaches Anthropic (401 with the stand-in credential); one naming `10.244.0.91`, 403; with no `ip`, 403. |
| C30 | — | cluster | R15 | proven | From a mock Pod (`10.244.0.246`), straight to the gateway: a token naming another sandbox's address (`10.244.0.209`), 403 on `internet` (example.com) and on GitHub's route; with no `ip`, 403 on both; naming its own address, example.com 200 and `api.github.com` 200. |
| C31 | — | cluster, live | — | not verified | — |
| C32 | — | unit | R16 | proven | The `limits` token names `10.244.0.9`; three grants, `GET` only: `api.anthropic.com` `/api/oauth/usage`, `chatgpt.com` `/backend-api/wham/usage`, `api.z.ai` `/api/monitor/usage/quota/limit`. Not covered, under the gateway's rule replayed: the same path with `?x=1`, `/v1/messages`, `/backend-api/wham/usage/other`, a `POST` and a `DELETE`. |
| C33 | — | local | R16 | proven | `{ accepted: false, reason: unknown_profile }`, no entry, no claim; the same Create without `limits` accepted. |
| C34 | simulated: stub (the gateway answers) | unit | R16 | proven | Two reads at once: three requests, one per account with an endpoint, through `gateway.test:3000`, the token's `sub` `agora limits`; a repository's profile left out. Four minutes later none; five, three more. Over HTTP: the account read, `{ limits: {} }` without a reader, 405 for a `POST`. |
| C35 | simulated: stub (the gateway answers 403, or the tunnel is refused) | unit | R16 | proven | ChatGPT answered 403 after a read: its windows 12 % and 3 %, `stale`, "chatgpt.com answered 403", checked at the first read; Anthropic not stale. Never read: no window, `stale`, "the gateway refused the tunnel: 403". After 12:00 the 5-hour window at 0 % with no reset, the week still 19 %. |
| C36 | — | unit | R16 | proven | Claude: 5-hour 7 % until `2026-10-07T11:59:59.706Z`, week 19 %. ChatGPT: 12 % and 3 %, their resets from `reset_at`, plan `plus`. z.ai: 5-hour 0 % with no reset, week 1 % until `nextResetTime`, the MCP limit left out, plan `lite`. Another shape: no window, for each. |
| C37 | simulated: stub (a stand-in gateway and provider) | local | R16 | proven | One tunnel, `api.anthropic.com:443 Bearer grant`; at the provider `/api/oauth/usage` with `Bearer agora-placeholder` and `oauth-2025-04-20`; the answer read, 200. Another token: rejected, "the gateway refused the tunnel: 403". |

The partial verdicts are tracked in #107.

## Not covered

| Failure | Issue |
| --- | --- |
| The gateway unreachable: 502 from the bridge | #110 |
| An execution's JWT expiring | #110 |

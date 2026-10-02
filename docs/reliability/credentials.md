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

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| C1 | — | cluster | R1 | partial: the refusals are asserted non-zero, not exactly one | 503 from the bridge, one refusal counted. Before any credential is attached, the outbound attempts of the pool's Pod are refused too. |
| C1 | — | cluster | R2 | partial: the refusals are asserted non-zero, not exactly one | 503 from the bridge, one refusal counted. |
| C2 | — | cluster | R1 | proven | 400 from Anthropic ("anthropic-version: header is required"): TLS accepted, Bearer set by the gateway; tunnel → 200. |
| C2 | — | cluster | R2 | proven | 400 from Anthropic ("anthropic-version: header is required"); tunnel → 200. |
| C3 | — | live | R1 | proven | "Paris." in 2.0 s, `end_turn`; seven tunnels to `api.anthropic.com:443`, last `CONNECT` response 200. |
| C3 | — | live | R2 | proven | "Paris." in 2.2 s; three tunnels to `api.anthropic.com:443`, last 200. |
| C4 | — | cluster | R0 | partial: the gateway's decisions are asserted; GitHub's answers are observed | A read 200, write 201, push 200; B read 200, fetch 200; B write, B push, C and GraphQL 403 from the gateway. The created file exists on A only, checked in GitHub. |
| C4 | — | cluster | R1 | partial: the gateway's decisions are asserted; with stand-ins, no write can succeed | Permitted requests reach GitHub (401); B write, B push, C and GraphQL stop at the gateway (403). |
| C4 | — | cluster | R2 | partial: the gateway's decisions are asserted; with stand-ins, no write can succeed | Permitted requests reach GitHub (401); B write, B push, C and GraphQL stop at the gateway (403). |
| C5 | — | cluster | R0g | partial: probed by hand, no test | 401 for a missing, an expired and a foreign JWT. |
| C6 | — | cluster | R0g | partial: probed by hand, no test | 403 for `..`, `.`, `%2e` and `%2f`. |
| C7 | — | cluster | R0g | partial: probed by hand, no test | 404. |
| C8 | — | local | R3 | partial: the gateway's answers (reach, 403) are not exercised; the 503 is inferred from no token attached | Every assertion held, in each of its two tests. |
| C8 | — | cluster | R4 | proven | A warm claude-code Pod, before any claim: Anthropic answers (400, the probe sends no `anthropic-version`), `api.github.com` 403 from the gateway, which logs `jwt.sub` `agora warm <Pod>`. A warm mock Pod: 503 from the bridge, no hand-over in its log. |
| C9 | — | local | R3 | partial: requests between the tokens are not exercised | Every assertion held (39.3 s). |
| C9 | — | cluster | R4 | proven | Renewed 604 s after the first token, 296 s before it ran out; 20 requests from the Pod meanwhile, one every 30 s, none refused. |
| C10 | — | local | R3 | proven | Every assertion held, in each of its three tests (two in the log, one in the bridge). |
| C10 | — | cluster | R4 | partial: the warm token's tunnels closing is shown by the bridge's test only | The execution's token handed at 19:04:36.997, `initialize` dispatched 34 ms later. From the Pod, B reaches GitHub (401 with the stand-in PAT), C stops at the gateway (403); no request under the warm name after the hand-off. |
| C11 | simulated: stub, the warm token's signing held 1.5 s | local | R3 | proven | Every assertion held. |
| C12 | simulated: stub, the signer refusing | local | R3 | partial: no request refused for an expiry during the turn is not exercised | Every assertion held, in each of its three tests. |
| C12 | — | cluster | R4 | partial: the previous tunnels closing is shown by the bridge's test only | Token until 19:06:10 → 19:06:12, the new one handed 7 ms before the prompt left; the turn's request reached Anthropic (400) under the execution's name. |
| C13 | — | live | R4 | proven | Session open in 1,809 ms on a warm Pod. The opening and one turn on `haiku`: 7 tunnels to `api.anthropic.com:443`, none refused over the Pod's life. |
| C14 | — | local | R3 | proven | Every assertion held. |
| C14 | — | cluster | R4 | proven | `unknown_profile`, nothing written. |
| C15 | — | cluster | R5 | proven | 200 from z.ai, four models listed; the gateway's route `zai` answered 200 under the execution's name. |

The partial verdicts are tracked in #107.

## Not covered

| Failure | Issue |
| --- | --- |
| The gateway unreachable: 502 from the bridge | #110 |
| An execution's JWT expiring | #110 |

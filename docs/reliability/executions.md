# Executions

The evidence behind the acceptance cases of `specs/executions.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-09-30 | `7afc4d7` | cluster | g4 under Kata, Agent Sandbox v1.0.3, thin bridge images: mock, and claude-code 2.1.261 with claude-agent-acp 0.75.1 and no credential. `apps/lab/scripts/live-cases.ts` against the deployed lab, where case E*n* was case *n*. Deadline cases with a 60 s lease, re-armed three times per lease. |
| R2 | 2026-09-30 | `7afc4d7` | local | `npm run check`: the two bridge tests in `packages/harness-bridge/test/bridge.test.ts` now named E27. |
| R3 | 2026-10-02 | `0669fc5` | local | `npm run check`: the mechanics against real bridges (`packages/executions`), and the cases the log decides with PostgreSQL 17.11 (`packages/log`, as in `log.md` R1); renewal step 1 s instead of a minute for E12 and E13. |
| R4 | 2026-10-02 | `f240cd0` | cluster | g4 under Kata, Agent Sandbox v1.0.3. The lab `agora-lab@sha256:1973a988…` built from that commit, on the `agora` database (CloudNativePG, PostgreSQL 17.4); pools `agora-harness-mock@sha256:1a1cc63c…` and `agora-harness-claude-code@sha256:5f3bb480…` (claude-agent-acp 0.75.1). `apps/lab/scripts/live-cases.ts` from that commit, against the deployed lab. Deadline cases with a 60 s lease and the lab's renewal step (a third of the lease). |
| R5 | 2026-10-02 | `31456b0` | local | `npm run check`: real bridges; a stdio adapter that reads its native file once, when it starts, and the mock agent in the same mode (`AGORA_MOCK_READ_AT_START`), waited for as a pool Pod; PostgreSQL 17.11 for the log's tests. |
| R6 | 2026-10-02 | `31456b0` | cluster, live | g4 under Kata, Agent Sandbox v1.0.3. The lab `agora-lab@sha256:88c0d767…` built from that commit; the mock and claude-code pools as in R4, and `agora-harness-opencode@sha256:5b7b6182…` (opencode 1.18.34 on z.ai's Coding Plan, base profile `zai`). `apps/lab/scripts/live-cases.ts` from `926af62`, the same as that commit's; the bridges' logs read with `kubectl`. E22 and E30 billed: claude-code on its default model, opencode on glm-5.3. |
| R7 | 2026-10-03 | `ddac202` | cluster, live | g4 under Kata. The lab as in R6 of `credentials.md` (`4b26f3c`); the pool `agora-harness-codex@sha256:0eae81a3…` (codex 0.159.3, codex-acp 2.1.1, base profile `chatgpt`), the gateway holding the cluster's own ChatGPT session (Plus). `apps/lab/scripts/live-cases.ts` from this branch. E31 billed on the subscription. |
| R8 | 2026-10-03 | `05fbbb8` | cluster, live | g4 under Kata, Agent Sandbox v1.0.3. The server `agora-server@sha256:31c1d086…` built from that commit, in the namespace `agora` behind agora.bretagne.dev, on the `agora` database (CloudNativePG, PostgreSQL 17.4); the pools mock `1a1cc63c…`, claude-code `5f3bb480…`, opencode `5b7b6182…` and codex `0eae81a3…`, their warm Pods recreated for the server's anchor address. `apps/server/scripts/live-cases.ts` from that commit, all 34 cases in one run; C10 and C12–C16 refused `quota` there — the run's stopped executions count until their deadline — and were played again once no claim was left. E22, E30 and E31 billed. |
| R9 | 2026-10-04 | `4261ef0` | local | `npm run check`: Node 24.20.0, real bridges with the stdio test adapter. |
| R10 | 2026-10-06 | `25bc00a` | live | g4 under Kata. The server `agora-server@sha256:2547a1f5…` and the pools claude-code `0345a542…`, opencode `44f3d8c2…` and codex `e88bc2bb…`, built from `4e33168` (infra-k8s #212), each in the mode, model and effort its pool declares: `bypassPermissions`, `opus`, `high`; `build`, `zai-coding-plan/glm-5.3`, `high`; `agent-full-access`, `gpt-6.1-sol`, `high`. `apps/server/scripts/live-cases.ts` from that commit, through `kubectl port-forward`. Billed: two short turns per harness. |
| R11 | 2026-10-06 | `b4efc8e` | cluster, live | As R15 of `credentials.md`: the server signing each token with its Pod's address, the gateway checking it on every route. One case per run. E22, E30 and E31 billed. |
| R12 | 2026-10-31 | `3bbe489` | cluster | g4 under Kata, Agent Sandbox v1.0.3. The server `agora-server@sha256:774ba830…` and the pool `mock-8315d36582ec`, built from that commit (infra-k8s #313); the template at 1 CPU and 4 GiB (infra-k8s #312). `apps/server/scripts/live-cases.ts` from that commit, on the server Pod's address. |
| R13 | 2026-11-04 | `ea042cb` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:3def865e…`; the pools `claude-code-48de2cb17779` (claude-agent-acp 0.100.0, claude-code 2.1.316), `codex-7fc81aec7cce` (codex-acp 2.5.0, codex 0.165.0) and `opencode-9ed4fac4159e` (1.18.34), each harness with its pool's default model; the cases' owner. E31 and E33, on the new adapters. |
| R14 | 2026-11-11 | `c27561b` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:6ffb1fdc…`; the pools `claude-code-220dcdea6c5d` (claude-agent-acp 0.106.0, claude-code 2.1.322), `codex-156dc39bef82` (codex-acp 2.6.0, codex 0.166.0) and `opencode-8ec41e3d2297` (1.19.5), each harness with its pool's default model; the cases' owner. E30, E31 and E33, on the new harnesses (agora #204, infra-k8s #358). |
| R15 | 2026-11-26 | `bbb3c64` | local | `packages/log`'s `node test/run.ts test/ends.test.ts test/delegation.test.ts test/recovery.test.ts`, 105 tests, all green: Node 24.22.3, PostgreSQL 17.5 (`@embedded-postgres/linux-x64`), each test on a database of its own; FakeKube with real bridges and the mock agent; each execution a delegate's, its delegator's `spawn_agent` made through Agora's MCP server; renewal step 1 s. |
| R16 | 2026-11-26 | `bbb3c64` | local | The preview of pull request #243, `pr-243-agora.preview.bretagne.dev`, its image `agora-server:bbb3c64…` (preview workflow run 45782987269): its in-process sandboxes, a real bridge with the mock agent each, Kubernetes stood in for (`preview.md`). Each case a Create of the pool `mock` carrying its message, then its thread read over HTTP until `execution.ended`; the client it serves fetched, not rendered: no browser could start in the sandbox the run came from. |
| R17 | 2026-11-26 | `1dc9309` | local, unit | `packages/log`'s `node test/run.ts test/ends.test.ts test/delegation.test.ts test/recovery.test.ts`, 107 tests, and `packages/executions`' `npm test`, 8 tests, all green: Node 24.22.3, PostgreSQL 17.5 (`@embedded-postgres/linux-x64`), each test on a database of its own; FakeKube with real bridges and the mock agent; each execution of `ends.test.ts` a delegate's, its delegator's `spawn_agent` made through Agora's MCP server; renewal step 1 s. The `check` job of pull request #243 on the same commit (GitHub Actions job 139842350812), all green. |
| R18 | 2026-11-26 | `c0c188d` | local, unit | The `check` jobs of pull request #243 (GitHub Actions job 139859475633) and of the push to `feat/execution-end-cause` (139859445492) on that commit, all green: Node 24, PostgreSQL 17 (`postgres:17`), each test on a database of its own, Playwright's Chromium headless shell, on ubuntu-26.04. E41's delegator in a turn of its own (`/sleep 120`) from its delegate's start, its lease renewed past the delegate's initial deadline. |
| R19 | 2026-11-26 | `9c285e3` | local, unit | `packages/log`'s `node test/run.ts test/ends.test.ts`, 10 tests, then `test/delegation.test.ts test/recovery.test.ts`, 99, and `packages/executions`' `npm test`, 9, all green: Node 24.22.3, PostgreSQL 17.5 (`@embedded-postgres/linux-x64`), each test on a database of its own; FakeKube with real bridges and the mock agent; renewal step 1 s. The `check` jobs of pull request #243 (GitHub Actions job 139884531706) and of the push (139884500162) on that commit, all green. The new E39 test of the mechanics failed on the mechanics of `7f8c14b`: no read within the margin, nothing kept. |

## Cases

E5 to E11 and E28 are the cases `specs/executions.md` keeps from before the log took them over:
what they covered is the log's now, with its own cases (`log.md`). Their rows are evidence for
`7afc4d7`.

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| E1 | — | cluster | R1 | proven | Ready in 1,015 ms, `warm` launch. |
| E1 | — | cluster | R4 | proven | Ready in 307 ms, `warm` launch, `initialize` answered by agora-mock-agent. |
| E1 | — | cluster | R8 | proven | Ready in 315 ms, `warm` launch, `initialize` answered by agora-mock-agent. |
| E2 | — | cluster | R1 | proven | Two `cold` launches ready in 4,363 and 6,140 ms; the remaining `warm` launch in 319 ms. |
| E2 | — | cluster | R4 | proven | `cold` 4,414 ms, `warm` 312 ms, `cold` 4,415 ms. |
| E2 | — | cluster | R8 | proven | Cold 4,442 ms; warm 324 ms; cold 4,409 ms. |
| E3 | — | cluster | R1 | proven | Same name, a single claim; asserted by the E2 test. |
| E3 | — | local | R3 | proven | Every assertion held. |
| E3 | — | cluster | R4 | proven | The same answer twice, one execution, a single claim. |
| E3 | — | cluster | R8 | proven | The same answer twice, one execution, a single claim. |
| E4 | — | cluster | R1 | partial: the reasons are observed, not asserted | 400 "pool not in the catalogue"; 429 "quota reached: 6 active executions out of 6". |
| E4 | — | local | R3 | proven | Every assertion held. |
| E4 | — | cluster | R4 | proven | `unknown_pool`; `quota`. |
| E4 | — | cluster | R8 | proven | "unknown_pool"; "quota". |
| E5 | — | cluster | R1 | partial: that Agora answered `initialize` itself is not asserted | `initialize` answered, naming `agora-mock-agent`; session recorded on the claim; `end_turn`; positions 2–4, increasing. |
| E6 | — | cluster | R1 | proven | "refused: a turn is already in progress". |
| E7 | — | cluster | R1 | proven | `cancelled`, execution ready. |
| E8 | real: the consumer closes its connection | cluster | R1 | proven | Request replayed, turn closed. |
| E9 | real: the consumer closes its connection for 7 s | cluster | R1 | proven | 7 frames replayed, no gap. |
| E10 | real: Agora terminates its connection to the bridge (lab `drop-bridge`) | cluster | R1 | proven | *Uncertain*, then `end_turn`; six numbered chunks and the final text arrived once, in order. Rejoined without replay or `initialize`. |
| E11 | real: the lab process exits (lab `restart`); Kubernetes restarts it | cluster | R1 | partial: the *uncertain* state and the absence of a second `initialize` are not asserted | Six claims found at startup; turn *uncertain*, then `end_turn`. Consumer positions reset to a new epoch and the final answer arrived. |
| E12 | — | cluster | R1 | partial: one renewal is asserted, not one per minute | Deadline pushed back during the turn, under the limit. |
| E12 | — | local | R3 | proven | Two tests: moving forward at each step, never beyond start + maximum duration. |
| E12 | — | cluster | R4 | partial: one move is asserted, not one per step | Deadline 14:06:25.055 → 14:06:45.827 during the turn, under the limit. |
| E12 | — | cluster | R8 | partial: one move is asserted, not one per step | The deadline moved from 09:13:46.044 to 09:14:06.632 during the turn. |
| E13 | — | cluster | R1 | partial: the deadline's value is not asserted | Deadline set at the end of the turn, unchanged 25 s later. |
| E13 | — | local | R3 | proven | Every assertion held. |
| E13 | — | cluster | R4 | partial: the deadline's value is not asserted | Deadline set at the end of the turn, unchanged 25 s later. |
| E13 | — | cluster | R8 | partial: the deadline's value is not asserted | The deadline set at the end of the turn, unchanged 25 s later. |
| E14 | real: the deadline passes between two turns | cluster | R1 | proven | Destroyed by Agent Sandbox; anchor pushed (1 file, 239 bytes). |
| E14 | real: the deadline passes between two turns | cluster | R4 | proven | Destroyed by Agent Sandbox; anchor pushed by the Pod. |
| E14 | real: the deadline passes between two turns | cluster | R8 | proven | Destroyed by Agent Sandbox; the anchor pushed by the Pod. |
| E15 | real: the turn reaches its 30 s maximum | cluster | R1 | partial: the time of destruction is not asserted | Destroyed with the turn in progress; anchor pushed. |
| E15 | real: the turn reaches its 30 s maximum | cluster | R4 | partial: the time of destruction is not asserted | Destroyed with the turn in progress, the turn failed; anchor pushed. |
| E15 | real: the turn reaches its 30 s maximum | cluster | R8 | partial: the time of destruction is not asserted | Destroyed with the turn in progress, the turn failed; an anchor. |
| E16 | — | cluster | R1 | partial: the end of renewal is not asserted | *Stopped*, destroyed at the deadline; anchor with the turn's text. |
| E16 | — | cluster | R4 | partial: the end of renewal is not asserted | Destroyed at the deadline; anchor with the turn's text. |
| E16 | — | cluster | R6 | proven | Stopped, destroyed at the deadline; anchor pushed by the Pod. |
| E16 | — | cluster | R8 | proven | Stopped, destroyed at the deadline; an anchor. |
| E17 | — | cluster | R1 | partial: the end of renewal is not asserted | Turn `cancelled`, destroyed at the deadline; anchor pushed. |
| E17 | — | cluster | R4 | partial: the end of renewal is not asserted | Turn cancelled, destroyed at the deadline; anchor pushed. |
| E17 | — | cluster | R8 | partial: the end of renewal is not asserted | The turn cancelled, destroyed at the deadline; an anchor. |
| E18 | — | cluster | R1 | partial: the restored Session id is not compared with the anchored one | Ready in 425 ms, session resumed, the agent recalls "mirabelle". |
| E18 | — | cluster | R4 | partial: the ACP session id is not compared with the anchored one | Ready in 415 ms, a new Session restored from the anchor, the agent recalls "mirabelle". |
| E18 | — | cluster | R6 | partial: the ACP session id is not compared with the anchored one | Ready in 390 ms, the anchor placed before `initialize`; a new Session restored from it, the agent remembers "mirabelle". |
| E18 | — | cluster | R8 | partial: the ACP session id is not compared with the anchored one | Ready in 308 ms, a new Session, the agent remembers "mirabelle". |
| E19 | real: the adapter exits (mock `/crash`, code 3) | cluster | R1 | partial: the end of renewal is not asserted | *Lost*; anchor pushed despite the dead adapter. |
| E19 | real: the adapter exits (mock `/crash`, code 3) | cluster | R4 | partial: the end of renewal is not asserted | Lost (`adapter_exited`); anchor pushed despite the dead adapter. |
| E19 | real: the adapter exits (mock `/crash`, code 3) | cluster | R8 | partial: the end of renewal is not asserted | Lost (`adapter_exited`), the deadline left alone; the anchor pushed despite the dead adapter. |
| E19 | real: the adapter exits (mock `/crash`, code 3) | cluster | R12 | proven | Lost (`adapter_exited`) at `2026-10-31T09:02:31.203Z`, the deadline moved to `2026-10-31T09:02:31.207Z`; ended 1 s after the loss, the anchor `ca1f817d…` pushed despite the dead adapter, holding the turn before. |
| E20 | — | cluster | R1 | proven | 401 everywhere; valid token 200 / 101. |
| E20 | — | local | R3 | proven | Every assertion held. |
| E20 | — | cluster | R4 | proven | 401 everywhere; valid token 200 / 101. |
| E20 | — | cluster | R8 | proven | No token, expired, another sandbox's, another key's: 401/401 each; the valid control 200/101. |
| E21 | — | cluster | R1 | partial: that nothing is stored is not asserted | 401 without a token, 401 with a fake one. |
| E21 | — | local | R3 | proven | Every assertion held. |
| E21 | — | cluster | R4 | proven | 401 without a token, 401 with a fake one; nothing stored. |
| E21 | — | cluster | R8 | proven | No token 401, fake token 401; nothing stored. |
| E22 | — | cluster | R1 | partial: the anchor's push and restore are reported, not asserted | Ready in 362 ms with claude-agent-acp 0.75.1. Without a credential: no answer in 120 s, turn cancelled; 11,230-byte anchor pushed and restored by `session/resume`. |
| E22 | — | cluster | R4 | partial: the anchor's push and restore are reported, not asserted | Ready in 19,157 ms with claude-agent-acp 0.75.1. Without a credential: no answer in 120 s, turn cancelled; anchor restored by `session/resume`. |
| E22 | — | cluster | R6 | partial: the anchor's push and restore are reported, not asserted | Ready in 2,064 ms (19,157 ms in R4, before the execution's token went ahead of `initialize`); prompt done; restored by `session/resume`. |
| E22 | — | live | R8 | partial: the anchor's push and restore are reported, not asserted | Ready in 2,370 ms, claude-agent-acp 0.75.1, the prompt done; restored by `session/resume`. |
| E22 | — | live | R11 | partial: the anchor's push and restore are reported, not asserted | Under the address binding: ready in 1,822 ms, claude-agent-acp 0.85.1, the prompt done; restored by `session/resume`. |
| E27 | real: Agora terminates its connection and stays away 10 s (lab `drop-bridge`) | cluster | R1 | partial: the blocked writer is not asserted | After the 10 s disconnection, the unread text and the final answer arrived complete; 3,600 large chunks arrived once, in order. |
| E27 | real: no client connected | local | R2 | proven | The writer stayed blocked with no client; 20,000 lines of 1 KiB then arrived in order and the writer finished. Output written during a 2.3 s absence arrived in order and was not replayed to a later connection. |
| E27 | real: no client connected | local | R3 | proven | Every assertion held. |
| E27 | real: Agora terminates its connection and stays away 10 s (lab `drop-bridge`), during a short and a 3,600-line answer | cluster | R4 | partial: the blocked writer is not asserted | Output arrived in order, without a repeat; 165 lines in flight lost at the cut (61–225), the rest and the end arrived. |
| E27 | real: Agora terminates its connection and stays away 10 s (test route `drop-bridge`), during a short and a 3,600-line answer | cluster | R8 | partial: the blocked writer is not asserted | Output written while Agora was away arrived in order, short and large; none lost. |
| E28 | real: the lab process exits (lab `restart`); Kubernetes restarts it | cluster | R1 | proven | Same capabilities and session after restart; new positions epoch. The mock completed another prompt without a second `initialize`. |
| E29 | real: an adapter that reads its native file only at start | local | R5 | proven | Every assertion held, in each of its five tests (three in the bridge, two in the log). |
| E29 | — | cluster | R6 | partial: the refusal and the control are shown locally only | Through E30: the bridge logged "anchor restored: 3 file(s) … adapter restarted" 65 ms after the execution's token, before `initialize`; the restarted opencode recalled "mirabelle". |
| E30 | — | live | R6 | proven | Ready in 679 ms on a warm Pod, OpenCode 1.18.34; "Paris" from glm-5.3 in 4.4 s; tunnels only to `api.z.ai:443` (2), none refused; the anchor restored by a restart in 2,831 ms, the agent recalls "mirabelle". |
| E30 | — | live | R8 | proven | Ready in 529 ms on a warm Pod, OpenCode 1.18.34; "Paris" in 2.9 s; tunnels only to `api.z.ai:443` (2), none refused; restored by a restart in 3,542 ms, recalls "mirabelle". |
| E30 | — | live | R11 | proven | Under the address binding: ready in 545 ms on a warm Pod, OpenCode 1.18.34; "Paris" in 3.6 s; tunnels only to `api.z.ai:443` (2), none refused; restored by a restart in 3,123 ms, recalls "mirabelle". |
| E30 | — | live | R14 | proven | Ready in 541 ms on a warm Pod, OpenCode 1.19.5; "Paris." in 2.1 s; tunnels only to `api.z.ai:443` (2), none refused; restored by a restart in 3,095 ms, recalls "mirabelle". |
| E31 | — | live | R7 | proven | Ready in 543 ms on a warm Pod, codex-acp 2.1.1; "Paris" in 5.2 s; tunnels only to `chatgpt.com:443` (4), none refused once the execution's token was in place; the anchor restored in 1,120 ms with no restart, the agent recalls "mirabelle". A first run counted 7 refusals in the pool, before the Pod's warm token: codex calls ChatGPT as soon as it starts. |
| E31 | — | live | R8 | proven | Ready in 533 ms on a warm Pod, codex-acp 2.1.1; "Paris" in 3.4 s; tunnels only to `chatgpt.com:443` (10), none refused after the warm token; restored in 800 ms, recalls "mirabelle". |
| E31 | — | live | R11 | proven | Under the address binding: ready in 560 ms on a warm Pod, codex-acp 2.1.1; "Paris" in 3.7 s; `chatgpt.com:443` ×29, none refused; restored in 1,397 ms, recalls "mirabelle". |
| E31 | — | live | R13 | proven | Ready in 564 ms on a warm Pod, codex-acp 2.5.0; "Paris" in 7.2 s; `chatgpt.com:443` ×5, none refused after the warm token; restored in 813 ms, recalls "mirabelle". |
| E31 | — | live | R14 | proven | Ready in 1,831 ms on a warm Pod, codex-acp 2.6.0; "Paris" in 3.7 s; `chatgpt.com:443` ×4, 7 refused in the pool before its warm token and none after; restored in 1,576 ms, recalls "mirabelle". |
| E32 | — | local | R9 | proven | Every assertion held. |
| E33 | — | live | R10 | proven | claude-code "`/home/harness/.agora/access.json`", opencode and codex "~/.agora/access.json", none with a tool call. The control, "read that file and give me its `sub` claim": one tool call each, and each answer held `agora <execution>` — codex's after a preface, "I’ll read the file and return only its `sub` claim". opencode first asked permission to read outside its workspace, answered allow once; claude-code and codex asked none. |
| E33 | — | live | R13 | proven | claude-code "`~/.agora/access.json`", opencode and codex "~/.agora/access.json", none with a tool call. The control, "read that file and give me its `sub` claim": one tool call each, and each answer held `agora <execution>`. |
| E33 | — | live | R14 | proven | claude-code "`~/.agora/access.json`", opencode and codex "~/.agora/access.json", none with a tool call. The control, "read that file and give me its `sub` claim": one tool call each (opencode asked one permission), and each answer held `agora <execution>`. |
| E34 | — | live | — | not verified | No run: no antigravity pool, no cluster Google login, no gateway route. |
| E36 | real: the turn reaches its 30 s maximum | local | R15 | proven | Its last deadline the prompt's time + 30,000 ms; `execution.ended` after it, cause `bound_reached`, its notice the same; one message to the delegator, `Its turn failed: its sandbox reached its time bound.`, still one 600 ms on. |
| E36 | real: the turn reaches its 30 s maximum (`/sleep 120`, `turnCapSeconds` 30) | local | R16 | partial: no delegator, the deadline not read | `session.opened` 3 s after the Create, then at +33 s `execution.break` and `execution.ended`, `cause` `{"kind":"bound_reached"}`. The client's bundle holds "it reached its time bound during the turn". |
| E37 | real: the 60 s lease runs out after the turn | local | R15 | proven | The delegate's last message at the delegator; `execution.ended` 59 s or more after the answer, cause `lease_expired`, `turn` `ended`, its notice the same; no message of Agora's 1.5 s on. |
| E38 | real: the adapter exits with code 3 (mock `/die`) | local | R15 | proven | `execution.lost` `{reason: adapter_exited, exitCode: 3, signal: null}`, its notice the same; one message, `Its execution was lost: the agent's process exited with code 3.`; `execution.ended` cause `adapter_exited`, exit code 3; still one message 600 ms on. |
| E38 | real: the adapter exits with code 3 (mock `/die 1`) | local | R16 | partial: no delegator | At +3 s: `execution.lost` `adapter_exited`, `exitCode` 3, `signal` null; `execution.ended`, `cause` `{"kind":"adapter_exited","signal":null,"exitCode":3}`. |
| E39 | simulated: fake-kube, the container reported `terminated` `OOMKilled` (137) and its bridge closed on the spot; the deadline brought to now | local | R15 | proven | The Pod seen `OOMKilled`; `execution.ended` cause `oom_killed`, no anchor, its notice the same; one message, `Its turn failed: its Pod was killed for lack of memory (OOMKilled).` |
| E40 | simulated: fake-kube, the Pod sent SIGTERM then not found, its claim left; the deadline brought to now | local | R15 | proven | The Pod seen gone; `execution.ended` cause `pod_gone`, `pod` null, its notice the same; one message, `Its turn failed: its Pod was gone before its deadline.` |
| E40 | simulated: fake-kube, the claim deleted 60 s before its deadline | local | R15 | proven | `execution.ended` at once, more than 30 s before the deadline, cause `pod_gone`, `pod` null, its notice the same; the same message. |
| E36 | real: the turn reaches its 30 s maximum | local | R17 | proven | As in R15: the last deadline the prompt's time + 30,000 ms; `execution.ended` after it, cause `bound_reached`, its notice the same; one message to the delegator, `Its turn failed: its sandbox reached its time bound.`, still one 600 ms on. |
| E37 | real: the 60 s lease runs out after the turn | local | R17 | proven | As in R15: the delegate's last message at the delegator; `execution.ended` 59 s or more after the answer, cause `lease_expired`, `turn` `ended`, its notice the same; no message of Agora's 1.5 s on. |
| E38 | real: the adapter exits with code 3 (mock `/die`) | local | R17 | proven | As in R15: `execution.lost` `{reason: adapter_exited, exitCode: 3, signal: null}`, its notice the same; one message, `Its execution was lost: the agent's process exited with code 3.`; `execution.ended` cause `adapter_exited`, exit code 3. |
| E39 | simulated: fake-kube, the container reported `terminated` `OOMKilled` (137) and its bridge closed on the spot; the deadline brought to now 5.5 s after the Pod was seen | local | R17 | proven | The Pod seen `OOMKilled`; `execution.ended` cause `oom_killed`, no anchor, its notice the same; one message, `Its turn failed: its Pod was killed for lack of memory (OOMKilled).` |
| E40 | simulated: fake-kube, the Pod sent SIGTERM then not found, its claim left; the deadline brought to now 5.5 s after the Pod was seen gone | local | R17 | proven | `execution.ended` cause `pod_gone`, `pod` null, its notice the same; one message, `Its turn failed: its Pod was gone before its deadline.` |
| E40 | simulated: fake-kube, the claim deleted 60 s before its deadline | local | R17 | proven | `execution.ended` at once, more than 30 s before the deadline, cause `pod_gone`, `pod` null, its notice the same; the same message. |
| E40 | simulated: stub, a cluster of one claim whose Pod read is held 140 ms, begun some 80 ms before the 5 s margin's end, answering no Pod; the watch silent | local | R17 | proven | The read begun before the margin's end and answered after it; nothing kept; one read in all, 2.5 s on, nothing kept still. The control, the same answer with the deadline a minute away: kept, `gone` true, its time within 5 s of the read. |
| E40 | simulated: forced-state, the facts `causeOf` reads written by the test | unit | R17 | proven | A Pod seen gone 60 ms after the deadline, and 1 ms inside the margin: `bound_reached`; seen 5 s before the deadline: `pod_gone`, `pod` null. No claim seen: `unobserved` with a UID recorded, `not_obtained` without. |
| E41 | simulated: fake-kube, every creation of the delegate's claim refused (503) until its initial deadline | local | R17 | proven | `execution.failed` `startup_failed`, then `execution.ended` at or after the initial deadline, cause `not_obtained`, its notice the same; no claim of the delegate created; one message to its delegator, `Its execution could not start.` |
| E41 | simulated: fake-kube, every creation of the delegate's claim refused (503) until its initial deadline; its delegator in a turn meanwhile | local | R18 | proven | Every assertion held, in both jobs: `execution.failed` `startup_failed` before `execution.ended` at or after the initial deadline, cause `not_obtained`, its notice the same; no claim of the delegate created; one message, `Its execution could not start.` |
| E39 | simulated: fake-kube, the container's `OOMKilled` reported 3 s after its bridge died, the deadline 6 s on, nothing renewing it | local | R19 | proven | The Pod seen `OOMKilled` less than 5 s before the deadline; `execution.ended` cause `oom_killed`, its notice the same; one message, `Its turn failed: its Pod was killed for lack of memory (OOMKilled).` |
| E39 | simulated: stub, a cluster of one claim, its deadline 4 s on, its Pod answering `OOMKilled`; another, its deadline 5,150 ms on, the answer held 200 ms; a third answering no Pod, its deadline 4 s on | local | R19 | proven | The first kept, `OOMKilled`, not gone, exit code 137; the second read begun before the margin's end, kept within it; the third read twice, nothing kept. |
| E39 | simulated: forced-state, the facts `causeOf` reads written by the test, a turn running at its bound | unit | R19 | proven | `OOMKilled` seen 4 s and 10 s before the deadline: `oom_killed`; `Error` seen 4 s before: `bound_reached`; 10 s before: `pod_gone`, `pod` `Error`. |
| E40 | simulated: stub, as in R17; the Pod read again within the margin | local | R19 | proven | The read begun before the margin's end and answered after it: nothing kept; read again within the margin, at least twice in all, nothing kept still. The control a minute away: kept, `gone` true. |
| E35 | — | live | — | not verified | As E34. Behind a stand-in for Google, agy 1.5.13 put no rule from the workspace's `AGENTS.md` into the model's request (`specs/credentials.md`, "Antigravity"). |

The partial verdicts are tracked in #107.

## Not covered

| Failure | Issue |
| --- | --- |
| A failed restore: the execution in *error* | #109 |
| OOMKilled and a Pod gone, on a cluster: whether the kubelet reports `OOMKilled` under Kata, what Agent Sandbox does with a deleted Pod | #244 |
| What the mechanics saw of a Pod, across an Agora restart: not kept, the cause read from the claim alone | #244 |

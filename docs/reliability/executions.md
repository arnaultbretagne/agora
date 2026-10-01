# Executions

Lifecycle failures and their verification. `architecture/executions.md` explains the flow;
`specs/executions.md` and `specs/log.md` define the required behavior.

Evidence names the component exercised:

- **Cluster relay:** the 2026-09-30 execution-relay run on g4/Kata, with Agent Sandbox and real
  mock-adapter processes; thin bridge images built from `7afc4d7`. Recorded in `specs/executions.md`.
- **Local log:** PostgreSQL 17.11 and real local mock bridges; Kubernetes and TokenReview
  simulated. Includes the 2026-10-01 lifecycle regressions at `97019a1`, recorded in `specs/log.md`.

Live execution cases are in `apps/lab/scripts/live-cases.ts`; log cases are in
`packages/log/test/log.test.ts`. Their setup and assertions stay with those tests.

| Failure event | Required outcome | Associated test | Evidence |
| --- | --- | --- | --- |
| Bridge connection drops during a turn. | Reconnect without resending the prompt; resolve uncertainty from its final answer. | Live 10, 27; log L10–L11. | Cluster relay: reconnection and ordered unread output passed. Local log: uncertainty and cancellation passed. |
| Agora exits during a turn. | Recover the same instance without replaying initialize or prompt; preserve the turn cap. | Live 11; log L14–L15. | Cluster relay: recovery passed. Local log: driver restart passed. Process SIGKILL and cap preservation across restart unverified. |
| Adapter dies while its Pod survives. | Stop sending/renewing; retain quota until claim disappearance; accept the final anchor. | Live 19; log L37. | Cluster relay: loss and anchor passed. Local log: quota/end passed with an injected 1011 close. |
| Turn reaches its cap without a final answer. | Agent Sandbox terminates it; record interruption and the final anchor when available. | Live 15. | Cluster relay: destruction at a 30-second cap and anchor passed. Log cap enforcement unverified. |
| Claim is deleting while its Pod is alive. | Keep admission closed and quota occupied until claim disappearance. | Log L38. | Local log: passed with simulated foreground deletion. Cluster log: unverified. |
| Agora restarts during the Pod's anchor push. | Authenticate, attribute to the original Session, publish once and restore native history. | Log L40. | Local log: HTTP push and mock restoration passed. Cluster log: unverified. |
| Native restoration fails before Session readiness. | Report failure and keep Write closed. | No dedicated failure case. | Unverified; live 18, 22 and log L12 cover successful restoration only. |

The next cluster runs exercise log L37, L38 and L40 with actual adapter death, foreground
deletion and Agora process restart. Reports record the triggering event, observed recovery,
tested commit and images. Cluster relay results retain their original scope.

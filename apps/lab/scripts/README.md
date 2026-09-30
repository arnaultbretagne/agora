# scripts

`live-cases.ts` plays the cases of `docs/specs/executions.md` and `docs/specs/credentials.md` against the
deployed lab, with real Kata sandboxes destroyed by Agent Sandbox. From g4, the lab Pod's IP is
reachable:

```sh
node apps/lab/scripts/live-cases.ts http://<lab ip>:8080 [case numbers]
```

Case 26 targets public stand-in repos unless `GITHUB_A`, `GITHUB_B` (and `GITHUB_C`) name
repos the gateway's PAT can write to.

Cases 27–28 exercise a paused bridge reader and process-level initialization after a lab restart.
Consumer reconnections carry the positions epoch and reset after an Agora restart.

# scripts

`live-cases.ts` plays the acceptance cases of `docs/specs/executions.md` (E…) and
`docs/specs/credentials.md` (C1–C4) against the deployed lab, with real Kata sandboxes destroyed
by Agent Sandbox. From g4, the lab Pod's IP is reachable:

```sh
node apps/lab/scripts/live-cases.ts http://<lab ip>:8080 [case IDs, e.g. E10 C3]
```

C4 targets public stand-in repos unless `GITHUB_A`, `GITHUB_B` (and `GITHUB_C`) name
repos the gateway's PAT can write to.

E27–E28 exercise a paused bridge reader and process-level initialization after a lab restart.
Consumer reconnections carry the positions epoch and reset after an Agora restart.

Its output is the evidence recorded in `docs/reliability/`: keep it whole, with the commit and
images it ran against, in the pull request that records it.

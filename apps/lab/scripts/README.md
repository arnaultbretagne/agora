# scripts

`live-cases.ts` plays acceptance cases of `docs/specs/executions.md` (E…), `log.md` (L…) and
`credentials.md` (C1–C4, C8–C14) against the deployed lab, with real Kata sandboxes destroyed by Agent
Sandbox. From g4, the lab Pod's IP is reachable:

```sh
node apps/lab/scripts/live-cases.ts http://<lab ip>:8080 [case IDs, e.g. E14 L18 C3]
```

C3 is a billed prompt. C4 targets public stand-in repos unless `GITHUB_A`, `GITHUB_B` (and
`GITHUB_C`) name repos the gateway's PAT can write to. L17 and L18 restart the lab.

C8–C13 look into the Pods and the gateway as the operator, through `KUBECTL` (default `kubectl`;
on g4, `KUBECTL="sudo -n k0s kubectl"`): a warm Pod has no execution to speak for it. They read the
bridges' and the gateway's logs, and send requests from a Pod through its bridge. C9 waits for a
warm token's renewal: about ten minutes, last.

Its output is the evidence recorded in `docs/reliability/`: keep it whole, with the commit and
images it ran against, in the pull request that records it.

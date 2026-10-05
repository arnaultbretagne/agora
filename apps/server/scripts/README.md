# scripts

`live-cases.ts` plays acceptance cases of `docs/specs/executions.md` (E…), `log.md` (L…) and
`credentials.md` (C1–C4, C7–C16, C23–C26) against the deployed server (`TEST_ROUTES` `true`), with real Kata sandboxes destroyed by Agent
Sandbox. From g4, the server Pod's IP is reachable:

```sh
node apps/server/scripts/live-cases.ts http://<server ip>:8080 [case IDs, e.g. E14 L18 C3]
```

C3 is a billed prompt. C4 targets public stand-in repos unless `GITHUB_A`, `GITHUB_B` (and
`GITHUB_C`) name repos the gateway's PAT can write to. L17 and L18 restart the server.
C23–C26 need `internet` offered. C25 resolves `<PRIVATE_ADDRESS>.nip.io` (default `10.10.20.1`, g4's
router, which refuses port 443): set it to a private address of the cluster's network that refuses
port 443. A Create names only offered profiles, so C7, C15, C16 and C24 hand their services through
the test credentials route.

C8–C13 look into the Pods and the gateway as the operator, through `KUBECTL` (default `kubectl`;
on g4, `KUBECTL="sudo -n k0s kubectl"`): a warm Pod has no execution to speak for it. They read the
bridges' and the gateway's logs, and send requests from a Pod through its bridge. C9 waits for a
warm token's renewal: about ten minutes, last.

Its output is the evidence recorded in `docs/reliability/`: keep it whole, with the commit and
images it ran against, in the pull request that records it.

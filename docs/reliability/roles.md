# Roles

The evidence behind the acceptance cases of `specs/roles.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-16 | `f114962` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own; the lab's executions on FakeKube, real bridges and the mock agent, which repeats what it is given; two roles of the tests' own; P1 on the real server process, reading the repository's cards. Nineteen guards were removed in turn, and each time one of P1 to P7, P9, P10, P12, D53 to D55 failed; a twentieth shows nowhere — a Workstream's role read from its last Create, which every Create records the same. |
| R2 | 2026-11-16 | `808df67` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:3cf14450…`; the pools `claude-code-8d9e19335569` (claude-agent-acp 0.106.0, claude-code 2.1.322) and `codex-0b925b298579` (codex-acp 2.6.0, codex 0.166.0), each harness with its pool's default model; the cases' owner. P11, its repository `arnaultbretagne/agora`; played twice: the first Create was refused `invalid_create` for the script's own doing, a lease beyond the 600 s allowed. The pull request it left, #210, closed without merging. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| P1 | — | local | R1 | proven | `GET /api/config`: `dev`, `judge`, `lead`, `sre`, each `role`, `summary`, `harness`, `model`, `effort`, `access` and nothing else, a harness among the three; `lead`'s `access` `agora:delegate`, `judge`'s none, `codex`, `gpt-6.1-sol`, `xhigh`; no word of a persona. `ROLES_DIR` holding `broken.md` with no front matter: the server exits, `broken.md: a role card starts with its front matter`. |
| P2 | — | local | R1 | proven | One prompt, two blocks: `` From Agora, not the person: your role, `scout`. ``, a blank line, the persona, marked `scout`; then the message. The `user` element: the message alone, `role` `scout`, no `from`. The title its first line; `role` in the view and in the row. A Workstream started with none: its message alone, no `role` in its view nor its element. |
| P3 | — | local | R1 | proven | `judge`, a role no card has there: `unknown_role`; 7: `invalid_create`; 0 entries, no execution. |
| P4 | — | local | R1 | proven | Two prompts: the block with the first alone. A Workstream whose first message is `/sleep 3`: one `_session/steering` during it, its prompt the message alone; then a plain message: the block with its prompt. |
| P5 | real: the Pod ends at its deadline, its anchor received; then one whose push never reaches Agora | local | R1 | proven | The second execution's `origin` the anchor: its prompt the message alone. The Workstream whose anchor was lost: `origin` `new`; its first prompt three blocks — the role's, the catch-up, the message. |
| P6 | real: the anchor's push never reaches Agora | local | R1 | proven | A Create naming `plain`: `role_set`. One naming none: its body's `role` `scout`, the block with its first prompt, the view's `role` `scout`. One naming `scout`: accepted. A Workstream started with none, a Create naming `scout`: `role_set`; one naming none: no `role`. |
| P7 | — | local | R1 | proven | `/recall`, then two messages: the block with the second prompt alone; the first `/recall` alone. |
| P8 | simulated: synthetic-event, the agent's `session_info_update` sent by the mock's `/raw` | local | R1 | proven | The block's first line as a title: the view's title unchanged 500 ms on. `Scouting the tests`: taken. |
| P9 | simulated: forced-state, the card taken out of the lab's roles; real: the anchor's push never reaches Agora | local | R1 | proven | The second Create's `role` `scout`; no block in its first prompt, the message its last block; the view's `role` `scout`. |
| P10 | — | local | R1 | proven | The transcript's `user` line: the message alone; its `agent` line holds the role's line, the mock repeating it. The exchange a catch-up gives: its `user` the message alone. |
| P11 | — | live | R2 | proven | `a plan of 694 characters, nobody started before the word; then dev on claude-code, judge on codex; its last message names https://github.com/arnaultbretagne/agora/pull/210 (889 s)`; its first prompt opening on the role's block. Observed, not asserted: the pull request opened by `agora-contributor`, one file, one line; approved by `agora-reviewer`, its review opening `PASS`, then a line for each of R1 to R7. |
| P12 | real: the Pod ends at its deadline, its anchor received, twice | local | R1 | proven | `/recall` alone in the first execution; the second's `origin` its anchor: its first prompt opens on the block, then `prune`. The third's `origin` the second's anchor: its prompt carries none. |

## Not covered

| Failure | Issue |
| --- | --- |
| A harness that compacts a long conversation and loses the persona: nothing gives it again | — |
| A card changed between two Sessions of a Workstream: the next new Session takes the new one; no case shows it | — |

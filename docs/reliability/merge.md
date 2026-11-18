# Merge

The evidence behind the acceptance cases of `specs/merge.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-18 | `e1ddf46` | unit, local | `npm run check`, with `npm run test:browser`, all green, on g4 — V6 skipped, no Docker there: Node 24.20.0, PostgreSQL 17.12, each test on a database of its own, Playwright 1.63.0's Chromium. G1 and G3 as code alone, then with G2, G4 to G7, G10 and G11 on the lab — FakeKube, real bridges, the mock agent —, GitHub standing in as a fake of the engine's `GitHub`; G1, G10 and G11 against the MCP server on a port of its own, through the MCP TypeScript SDK 1.32.2's own client, as a harness calls it; G11's tokens signed by a real `GrantSigner` with a key of its own, each one recorded. G8 on the client's fold, then in a browser on the server's process, a stand-in for GitHub behind `GITHUB_TEST_API`. Beside it, four mutations of G10's rule, each caught by G10 run alone: the write held alone; any Workstream's delegates; another field than `rights`; `propose_merge` not listed to `agora:delegate`. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| G1 | — | unit, local | R1 | proven | A repository's write compiles to Agora's MCP endpoint among its grants, its read to none; `session/new`'s servers `agora` with the write, none with a read and a review. With `github:octo/app:write`: `propose_merge` alone listed, `repo` and `number` required; on `octo/app#7`, `proposed octo/app#7:`; on `octo/other`, a tool error, `not_allowed`. With `github:octo/app:read`: no tool; the call refused, `not_allowed`. |
| G2 | — | local | R1 | proven | `proposed octo/app#7: the person merges it from the card…`; the card `merge`, `pending`, `Add feature 7`, `octo/app`, 7, `https://github.com/octo/app/pull/7`, its text the link, `` `main ← feat/7` `` and `agora-contributor[bot]`. On `octo/other`, and with the read alone: `not_allowed`; #99: `not_found`; a closed one: `not_open`; a second: `question_pending`; `not a repo`: `invalid_query: repo`; an Ask of kind `merge` from the person, the card pending: refused, `question_pending`. |
| G3 | — | unit, local | R1 | partial: Merge open for `ready` alone is not asserted by G3's tests (G8's browser test asserts it for `review` and `ready`) | `clean` and `has_hooks`: `ready`; `blocked` with no approval on the head: `review`, with one: `blocked`; `unstable`: `checks`; `dirty`: `conflicts`; `behind`: `behind`; `draft`, and a draft GitHub says `clean`: `draft`; none: `computing`; closed: `closed`; merged: `merged`. On the lab: no state without a card; then `review`, then `ready`, the head `head7`. |
| G4 | — | local | R1 | partial: the squash and the operator are not asserted by G4's test, whose GitHub stands in for the operator's | `merge.merged`, the card's position and `f00d`; one merge asked, `octo/app#7` at `head7`; `From Agora, not the person: Pull request octo/app#7 merged (squash): f00d.`; the card `answered`, its outcome merged, `f00d`. |
| G5 | — | local | R1 | partial: after GitHub's refusal, the agent's message is not asserted | The review gone: `merge.refused`, `waiting for a review`, no merge asked, `From Agora, not the person: Pull request octo/app#7 not merged: waiting for a review.` GitHub refusing: `merge.refused`, `Repository rule violations found`. |
| G6 | — | local | R1 | partial: with no turn only, not during one | `question.cancelled` with the card's position; the Write accepted; the card `cancelled`, no question pending; the agent's next prompt holding `fix the tests first`; a new proposal then `proposed`. |
| G7 | simulated: forced-state, the engine detached between the Answer and its outcome, a new one started | local | R1 | proven | Merged on GitHub meanwhile: `merge.merged`, `m3rg3d`, no merge asked; started again: still one `merge.merged`. Not merged yet: one merge asked, `octo/app#9` at `head9`, a second `merge.merged`. |
| G8 | — | unit, local | R1 | partial: Merging… is not asserted | The fold: the card its own message, a `merge` tool call, `pending`, its position, title, URL, `repo`, `number`, no outcome; sending open; answered; merged `f00d1234`; refused `waiting for a review`; cancelled. The browser: the title a link to `https://github.com/owner/a/pull/7`, `owner/a#7 · Waiting for a review`, Merge disabled; GitHub saying `clean`, the card `ready`, Merge enabled; clicked: `Merged · f00d123`, one merge asked, `head7`, `squash`, the agent's message; a second card, then a message: `cancelled`, still one merge. |
| G9 | — | live | — | not verified | — |
| G10 | — | local | R1 | proven | `spawn_agent`, `send_message`, `stop_agent`, `list_agents`, `answer_agent`, `propose_merge`. Before any delegation, on `octo/app#7`: a tool error, `not_allowed`, no question. `github:octo/refused:write` asked, the person writing: `refused: not that one`. `github:octo/app:write` and `github:octo/infra:review` approved, each `started`; another Workstream of the person's giving `github:octo/other:write` to its own delegate. Stopped, then a second execution of the lead's Workstream: `octo/refused`, `octo/infra`, `octo/other`, each `not_allowed`, no question; `octo/app#7`: `proposed octo/app#7: the person merges it from the card…`, the card in the lead's Workstream `merge`, `pending`, `Add feature 7`, `octo/app`, 7, its URL; no question in either delegate's. |
| G11 | — | local | R1 | proven | After the delegation and the proposal, the card pending: the lead's profiles `agora:delegate`; every token signed for its execution `agora:delegate` alone, its grants one, `mcp.agora.internal`, `^/mcp$`. The delegate's: `github:octo/app:write` and `agora:submit`, `api.github.com` as `contributor` among its grants. |
| G12 | — | live | — | not verified | — |

## Not covered

| Failure | Issue |
| --- | --- |
| A lead proposing a pull request of a repository whose write it gave a delegate, which no delegate of its wrote: the card is shown, as for a holder of the write; no case shows it | — |

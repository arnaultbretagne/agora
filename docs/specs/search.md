# Search

Contract to implement: an API to search a person's Workstreams and to read one, which the client's
search box uses (`assistant-ui.md`, "Sidebar"). It reads the log's views (`log.md`, "Views"), and its
parameters are grep's and Read's: what an agent already does with files — grep to find lines, Read to
open a window of them — works on Workstreams unchanged.

**A Workstream is searched and read as a transcript of numbered lines: its exchanges, as the catch-up
gives them. Search finds lines as `grep -n` finds them in files; read opens a window of lines as an
agent's Read opens a file. Nothing is stored for either.**

## The transcript

What search and read see of a Workstream: its exchanges (`log.md`, "Continuing", "An exchange") as numbered
lines, read from its view's objects — its turns and their elements — and never stored.

| Rule | Detail |
| --- | --- |
| An exchange's lines | In the order of its turn's prompt: `## <n> · <started> · you`, then its `user` element's text; `## <n> · agent`, then its `agent_message_chunk` elements' text and one line per `tool` element — `[tool: <title>]`, or `[tool: <title> — failed]` when its status is `failed` — in the order of their first positions. `<n>` counts the turns from 1; `<started>` is the turn's `startedAt`, to the minute, in UTC. |
| Text | A `user` element's blocks as the catch-up gives them (`log.md`, "Continuing"); an `agent_message_chunk` element's `text`. Each is split at its line breaks; an element without text gives no line. |
| Numbers | From 1, across the Workstream, in that order. An exchange's numbers never change: only the last element of the exchange in progress grows, and nothing follows it; a rebuild gives the same lines. |
| Kinds | `header`, `user`, `agent`, `tool`. |
| Left out | Reasoning, tool content, plans, permissions, questions to the person, and what a resumed Session replays outside any turn. |

## Search

| Rule | Detail |
| --- | --- |
| Pattern | A regular expression, PostgreSQL's, `\b` being a word's edge as in ripgrep; case is matched unless `-i`. An invalid one is refused. |
| Searched | The `user` and `agent` lines of the caller's Workstreams — its own, sub-streams included, and its agents' folder's —, or of one of them; with `tools`, the `tool` lines too. Never a header. |
| Output | `workstreams_with_matches`, the default: each Workstream with a match, the most recently changed first, with its row (`log.md`, "The list"), how many of its lines match, and its latest matching line. `content`: each matching line, its Workstream, number and text — `<workstream>:<line>:<text>` as grep writes it —, with `-A`, `-B` or `-C` lines of context around it, marked as context. `count`: each Workstream's title and how many of its lines match. |
| Long lines | A line found or given as context is cut to 300 characters around its first match, the cuts marked `…`. |
| Pages | At most `head_limit` results, 20 by default and 100 at most, after skipping `offset`; when more follow, the next `offset`. |

## Read

| Rule | Detail |
| --- | --- |
| Window | One of the caller's Workstreams, every kind of line, from `offset` (1 by default), at most `limit` lines (2,000 by default) and 50 KB; a line beyond 2,000 characters cut, marked. When more follow, the next `offset` and the total; at the end, the total. |

## HTTP

| Route | Answer |
| --- | --- |
| `GET /api/search?pattern=P` | JSON, a search ("Search", "Read"): `output_mode`, `ignore_case`, `before`, `after`, `context`, `head_limit`, `offset`, `tools`, `workstream` as its parameters; `results`, and `next`, the next `offset`, or null. 400 `invalid_pattern`. |
| `GET /api/workstreams/{id}/read?offset=O&limit=L` | JSON, a read ("Search", "Read"): `lines`, each with its number, kind and text; `total`; `next`, the next `offset`, or null. The caller's: 404 `unknown_workstream` otherwise. |

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| S1 | A Workstream of two exchanges, the second calling a tool that succeeds and one that fails; its transcript read whole | Its two headers per exchange, the user's lines, the agent's, `[tool: …]` and `[tool: … — failed]`, numbered from 1 in that order. |
| S2 | The same transcript after a third exchange, then after its views are rebuilt | The first two exchanges' lines at the same numbers, with the same text. |
| S3 | An exchange in progress, its answer streaming | Its last lines grow; no line before them moves. |
| S4 | A text in a user's line, an agent's line and a tool's title, searched without `tools`, then with | Two lines, then three; never a header. |
| S5 | `workstreams_with_matches`, `content` with `-C 1`, `count` on two Workstreams | The Workstreams most recently changed first, each with its title and latest matching line; each match `id:line:text` with its context `id-line-text`; each Workstream's count. |
| S6 | `\bkube\b` without and with `-i`; a pattern that does not compile | Word edges as ripgrep's, case matched, then ignored; 400 `invalid_pattern`. |
| S7 | The pattern in another person's Workstream, in one of the caller's sub-streams, in `workstream` limited to one | Not found; found; that Workstream's lines only. |
| S8 | 30 Workstreams matching; `head_limit` 20, then the next `offset` | 20, a next `offset`; 10, none. |
| S9 | A read from an offset with a limit; from beyond the end; a window that reaches 50 KB first; a line of 3,000 characters | The window, numbered, the next `offset` and the total; none, the total; cut at 50 KB, the next `offset`; the line cut and marked. |
| S10 | A resumed Session replaying its history outside any turn; reasoning; a question to the person | In no line. |

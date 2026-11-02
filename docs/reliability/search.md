# Search

The evidence behind the acceptance cases of `specs/search.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-02 | `baf9ad3` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own. S1–S4 on transcripts the core projector folded from real exchanges with the mock agent, its tools written with `/raw`; S5–S10 on objects written as the projector writes them, rows in their lists for the searches' order. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| S1 | — | local | R1 | proven | Eleven lines: `## 1 · <time> · you`, `hello there`, `## 1 · agent`, `Echo #1: hello there.`, `## 2 · <time> · you`, the `/raw` prompt, `## 2 · agent`, `[tool: Edit demo.txt]`, `[tool: Run tests — failed]`, `Tools ran.`, `One failed.`; total 11, no next; the time to the minute. |
| S2 | — | local | R1 | proven | Eight lines after two exchanges; after the third, the same eight first and four more; after the rebuild, the twelve unchanged. |
| S3 | — | local | R1 | proven | `/sleep 3` answering: read with `… second 1/3` last, then with `… second 2/3` last; more lines, the earlier ones unchanged. |
| S4 | — | local | R1 | proven | Without `tools`: `find the zebra` and `Echo #1: find the zebra.`; with it, `[tool: Open zebra.txt]` too; `· (you\|agent)$` with `tools`: no result. |
| S5 | — | local | R1 | proven | By default the newer then the older: `Newer`, 1 line, line 4 `the needle`; `Older`, 2 lines, line 5 `another needle`. `content` with `context=1`: seven lines, each match and its context, a line two matches share given once. `count`: `Newer` 1, `Older` 2. |
| S6 | — | local | R1 | proven | `\bkube\b`: 1 line, `kubernetes` never; with `ignore_case`: 2; `(`: 400 `invalid_pattern`. |
| S7 | — | local | R1 | proven | The sub-stream, then the root; another person's Workstream never; with `workstream`, the root alone. |
| S8 | — | local | R1 | proven | 20 results and `next` 20; from 20, 10 and `next` null. |
| S9 | — | local | R1 | proven | From 3, two lines: 3 and 4, total 704, next 5; beyond the end: none, total 704, next null; read whole: stopped under 50 KB, the next offset its next line; the 3,000-character line cut at 2,000 and marked. |
| S10 | — | local | R1 | proven | Four lines: the two headers, `hello`, `the answer`; no replayed text, no reasoning, no question. |

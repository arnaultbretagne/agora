# Search

The evidence behind the acceptance cases of `specs/search.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-02 | `baf9ad3` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own. S1–S4 on transcripts the core projector folded from real exchanges with the mock agent, its tools written with `/raw`; S5–S10 on objects written as the projector writes them, rows in their lists for the searches' order. |
| R2 | 2026-11-02 | `4510577` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own, as R1. The transcript now inlines an element's text and computes it once; the tests are R1's, unchanged. |
| R3 | 2026-11-02 | `15b6b66` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11 with `pg_trgm` 1.6, each test on a database of its own. The search's first step reads `objects_text`; S1–S10 are R2's tests, unchanged. |
| R5 | 2026-11-04 | `8ed0819` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11 with `pg_trgm` 1.6; a real message into a running turn, through the mock agent. |
| R6 | 2026-11-04 | `fd0c720` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11 with `pg_trgm` 1.6; a real delegation in the lab, its `submit` as its delegator's own turn and sent into a turn. |
| R7 | 2026-11-11 | `c0d5049` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11; S15 on the lab, the mock agent reporting a sub-agent of its own. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| S1 | — | local | R1 | proven | Eleven lines: `## 1 · <time> · you`, `hello there`, `## 1 · agent`, `Echo #1: hello there.`, `## 2 · <time> · you`, the `/raw` prompt, `## 2 · agent`, `[tool: Edit demo.txt]`, `[tool: Run tests — failed]`, `Tools ran.`, `One failed.`; total 11, no next; the time to the minute. |
| S1 | — | local | R2 | proven | As R1: the same eleven lines, total 11, no next. |
| S1 | — | local | R3 | proven | As R2. |
| S2 | — | local | R1 | proven | Eight lines after two exchanges; after the third, the same eight first and four more; after the rebuild, the twelve unchanged. |
| S2 | — | local | R2 | proven | As R1: eight lines, then the same eight and four more; after the rebuild, the twelve unchanged. |
| S2 | — | local | R3 | proven | As R2. |
| S3 | — | local | R1 | proven | `/sleep 3` answering: read with `… second 1/3` last, then with `… second 2/3` last; more lines, the earlier ones unchanged. |
| S3 | — | local | R2 | proven | As R1: `… second 1/3` last, then `… second 2/3`; the earlier lines unchanged. |
| S3 | — | local | R3 | proven | As R2. |
| S4 | — | local | R1 | proven | Without `tools`: `find the zebra` and `Echo #1: find the zebra.`; with it, `[tool: Open zebra.txt]` too; `· (you\|agent)$` with `tools`: no result. |
| S4 | — | local | R2 | proven | As R1: two lines without `tools`, three with; a header never. |
| S4 | — | local | R3 | proven | As R2: two lines without `tools`, three with; a header never. |
| S5 | — | local | R1 | proven | By default the newer then the older: `Newer`, 1 line, line 4 `the needle`; `Older`, 2 lines, line 5 `another needle`. `content` with `context=1`: seven lines, each match and its context, a line two matches share given once. `count`: `Newer` 1, `Older` 2. |
| S5 | — | local | R2 | proven | As R1: `Newer` then `Older`, their counts and latest lines; `content` with its seven lines. |
| S5 | — | local | R3 | proven | As R2. |
| S6 | — | local | R1 | proven | `\bkube\b`: 1 line, `kubernetes` never; with `ignore_case`: 2; `(`: 400 `invalid_pattern`. |
| S6 | — | local | R2 | proven | As R1: 1 line, 2 with `ignore_case`; `(` refused, `invalid_pattern`. |
| S6 | — | local | R3 | proven | As R2: 1 line, 2 with `ignore_case`; `(` refused, `invalid_pattern`. |
| S7 | — | local | R1 | proven | The sub-stream, then the root; another person's Workstream never; with `workstream`, the root alone. |
| S7 | — | local | R2 | proven | As R1: the sub-stream, then the root; another person's never; the root alone with `workstream`. |
| S7 | — | local | R3 | proven | As R2. |
| S8 | — | local | R1 | proven | 20 results and `next` 20; from 20, 10 and `next` null. |
| S8 | — | local | R2 | proven | As R1: 20 and `next` 20; then 10 and `next` null. |
| S8 | — | local | R3 | proven | As R2. |
| S9 | — | local | R1 | proven | From 3, two lines: 3 and 4, total 704, next 5; beyond the end: none, total 704, next null; read whole: stopped under 50 KB, the next offset its next line; the 3,000-character line cut at 2,000 and marked. |
| S9 | — | local | R2 | proven | As R1: the windows, the 50 KB stop and the cut line as before. |
| S9 | — | local | R3 | proven | As R2. |
| S10 | — | local | R1 | proven | Four lines: the two headers, `hello`, `the answer`; no replayed text, no reasoning, no question. |
| S10 | — | local | R2 | proven | As R1: four lines; no replayed text, reasoning or question. |
| S10 | — | local | R3 | proven | As R2. |
| S11 | — | local | R3 | proven | On `the Kube cluster`, `a kube node`, `k.be written as such`: `kube` 1 line; `(?i)KUBE` 2; `(?i)^A KUBE` 1; `***=k.be` 1; each answered 200. |
| S14 | — | local | R5 | proven | Lines 1 to 10: `## 1 · you`, `/sleep 2`, `## 1 · agent`, `… second 1/2`, `## 1 · you, during the turn`, `also a needle` of kind `user`, `## 1 · agent`, `Heard: also a needle.`, `… second 2/2`, `Slept 2 s.`; the same once rebuilt; `a needle` found at 6 and 8. |
| S13 | — | local | R6 | proven | The delegate's first header ending `· delegator`, then `/sleep 5` of kind `user`. The delegator's: a header ending `· delegate`, then `count the quokkas`; `## n · delegate, during the turn`, then `count the wombats`, both of kind `user`. No line opening `From your `. `search` `wombats`: that line. |
| S15 | — | local | R7 | proven | Its transcript: `## 1 · <date> · parent`, `Count the files, and say how many.`, `## 1 · agent`, `Working on: Count the files.`, `[tool: ls -1 \| wc -l]`, `Done: 7 files.`; none of them in its host's. With no task: `## 1 · agent` first. |

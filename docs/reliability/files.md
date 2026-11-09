# Files

The evidence behind the acceptance cases of `specs/files.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-08 | `d4bc539` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own and a bucket of its own: the testkit's S3 endpoint (`FakeS3`), standing in for R2 with the answers measured on `agora-files` on 2026-11-08 — `412` for `If-None-Match: *` on an existing key, `400 BadDigest` for a wrong `x-amz-checksum-sha256`. Real bridges with the mock agent, whose `/file` returns an image in a tool's content and raw output, as Claude Code's `Read` does. `@aws-sdk/client-s3` 3.1156.0. Before it, on `975534a`, each guard removed in turn failed its case: no extraction (B1), no upload (B1), a `412` taken for an error (B2), the line sent unexpanded (B4), an unreadable anchor not failing the restore (B6), anyone reading a file (B7), no `attachment` (B7), the sweep blind to anchors (B8), no shared lock (B10), a waiting message unexpanded (B11). |
| R2 | 2026-11-09 | `ab55f71` | local | The move on a copy of production: `pg_dump` of `agora` (967 MB, 376,908 entries, 96,900 objects, 219 anchors) restored into PostgreSQL 17.11 on g4, the schema applied, `scripts/move-files.ts` run against the real bucket `agora-files` on R2 with its token, then VACUUM (FULL); the copy dropped after. |
| R3 | 2026-11-09 | `dfcdbf6` | cluster | Production, once deployed: server `agora-server@sha256:79600936…`, pool `mock-121a6566b122`, the real bucket `agora-files`. The move run on the log as the database owner, the server up, after an on-demand backup (`agora-pg-before-files-move-20261109`), then VACUUM (FULL). Then, through the server, a Workstream of a throwaway owner on the mock harness. Workstream a61b209e's thread, read from the node after: 1.9 MB to `snapshot-end` in 0.15 s, against 51.7 MB before. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| B1 | — | local | R1 | proven | `files` at `/params/update/content/0/content/data` and `/params/update/rawOutput/0/source/data`, 4194304 bytes, one SHA-256; one object `sha256/70121fcd…`; one PutObject; the tool's view 709 characters. |
| B2 | simulated: forced-state (the `files` row deleted, as a database restored from before it) | local | R1 | proven | PutObject answered `200`, then `412`; one object, one row, three entries referencing it. |
| B3 | — | local | R1 | proven | The two long chunks: `files` null each; the person's line `agora-file:sha256:23051872…` as text, `files` null, sent as written. |
| B4 | — | local | R1 | proven | The command's `files` at `/body/prompt/1/data`, the line's at `/params/prompt/1/data`, 512000 bytes; the agent: `Received an image, image/jpeg, 512000 bytes, sha256 4e5772e958cd.` |
| B4 | — | cluster | R3 | proven | A 300,000-byte PNG with a message: the command's `files` at `/body/prompt/1/data`, the line's at `/params/prompt/1/data`, one SHA-256; the agent: `an image, image/png, 300000 bytes, sha256 95bd68880cda`, the prefix of the bytes written. |
| B5 | real: the bucket's endpoint stopped, connections refused | local | R1 | proven | The Write refused `files_unavailable`, over HTTP `503 files_unavailable`; once the endpoint back, the tool line, then `File read.`; receive ordinals 1–7, each once; no diagnostic. |
| B6 | real: the bucket's endpoint stopped, connections refused | local | R1 | proven | Anchor `a770fd79…` → object `06fc11e1c3a2…`, its record's content null; restored, `groseille` recalled; the endpoint stopped: `execution.failed`, `restore_failed`. |
| B6 | — | cluster | R3 | partial: no restore from it, and R2 not stopped | The execution stopped, its Pod's anchor pushed at its end: record `3e7e994f…` naming object `2e021603…` (552 bytes), its content null. |
| B7 | — | local | R1 | proven | The owner: 200, `image/jpeg`; another owner: 404; an unknown digest: 404; `image/svg+xml` asked: `application/octet-stream`, `attachment`; `nosniff` on each. |
| B7 | — | cluster | R3 | partial: an unknown digest and another type not asked | The owner: 200, the same 300,000 bytes; another owner: 404. |
| B8 | simulated: forced-state (rows' times and objects' dates set as days had passed) | local | R1 | proven | Swept `{"rows":2,"orphans":1}`; three objects and three rows left: the referenced one, the recent one, the current anchor's. |
| B9 | simulated: forced-state (the log written inline by the provisioning login, as before the move) | local | R1 | proven | Moved `{"entries":3,"objects":1,"anchors":1,"files":3}`, the base64 of zeros among them; each entry expanded with the bytes R2 gives back equal to before, `9007199254740993` kept; then nothing more moved; three objects. |
| B9 | — | local | R2 | partial: each entry's expansion checked by the move itself; outside it, 20 entries drawn at random | Schema 223 ms; moved 192 entries, 96 objects, 219 anchors, 313 files (283 MB) stored, in 132 s; a second move: nothing, 3.9 s. Of the 100 rows long enough to hold a file, none holds one; 20 of 20 entries drawn expanded back from R2's bytes. Workstream a61b209e's views: 69,024,600 → 1,840,890 characters. VACUUM (FULL) 11 s: 839 → 503 MB (entries 426 → 307 MB, objects 248 → 180 MB, anchors 149 MB → 144 kB). |
| B9 | — | cluster | R3 | partial: each entry's expansion checked by the move itself; outside it, 20 entries drawn at random | Before: 967 MB (entries 441, objects 344, anchors 167 MB). Moved 192 entries, 96 objects, 219 anchors in 59 s, the server up; a second move: nothing. Of the 100 rows long enough to hold a file, none holds one; 20 of 20 entries drawn expanded back from R2. a61b209e's views 69,024,600 → 1,840,890 characters. VACUUM (FULL) 10.6 s; after: 504 MB (entries 308, objects 181 MB, anchors 144 kB). |
| B10 | simulated: forced-state (the test holds the files lock exclusive, deletes the row and the object, as a sweep would) | local | R1 | proven | The writer waited for the lock; PutObject `200`, then `200` again after the sweep; the entry's `files` naming the object, which is there. |
| B11 | real: the bucket's endpoint stopped, connections refused | local | R1 | proven | Held while the endpoint was stopped, one prompt sent; then sent with `files` at `/params/prompt/0/data`, 300000 bytes; the agent: `an image, image/png, 300000 bytes, sha256 c74902354a4b.` |
| B12 | simulated: forced-state (the test holds the files lock shared, as a writer storing a file) | local | R1 | proven | While storing: `null`, nothing deleted, no DeleteObjects; after: `{"rows":0,"orphans":1}`. |

## Not covered

| Failure | Issue |
| --- | --- |
| The real R2 failing or refusing: the cases that make it fail ran against the testkit's endpoint; the real one shows only its nominal paths (R3). | #195 |
| R2 accepting a connection and never answering: requests give up after 5 s without a connection or 30 s without progress, twice; no case holds a request that long. | #195 |
| A database error while an anchor is read for a restore: it propagates, and the restore is tried again; no case produces it. | #195 |

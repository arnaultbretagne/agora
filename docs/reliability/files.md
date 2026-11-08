# Files

The evidence behind the acceptance cases of `specs/files.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-08 | `d4bc539` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own and a bucket of its own: the testkit's S3 endpoint (`FakeS3`), standing in for R2 with the answers measured on `agora-files` on 2026-11-08 — `412` for `If-None-Match: *` on an existing key, `400 BadDigest` for a wrong `x-amz-checksum-sha256`. Real bridges with the mock agent, whose `/file` returns an image in a tool's content and raw output, as Claude Code's `Read` does. `@aws-sdk/client-s3` 3.1156.0. Before it, on `975534a`, each guard removed in turn failed its case: no extraction (B1), no upload (B1), a `412` taken for an error (B2), the line sent unexpanded (B4), an unreadable anchor not failing the restore (B6), anyone reading a file (B7), no `attachment` (B7), the sweep blind to anchors (B8), no shared lock (B10), a waiting message unexpanded (B11). |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| B1 | — | local | R1 | proven | `files` at `/params/update/content/0/content/data` and `/params/update/rawOutput/0/source/data`, 4194304 bytes, one SHA-256; one object `sha256/70121fcd…`; one PutObject; the tool's view 709 characters. |
| B2 | simulated: forced-state (the `files` row deleted, as a database restored from before it) | local | R1 | proven | PutObject answered `200`, then `412`; one object, one row, three entries referencing it. |
| B3 | — | local | R1 | proven | The two long chunks: `files` null each; the person's line `agora-file:sha256:23051872…` as text, `files` null, sent as written. |
| B4 | — | local | R1 | proven | The command's `files` at `/body/prompt/1/data`, the line's at `/params/prompt/1/data`, 512000 bytes; the agent: `Received an image, image/jpeg, 512000 bytes, sha256 4e5772e958cd.` |
| B5 | real: the bucket's endpoint stopped, connections refused | local | R1 | proven | The Write refused `files_unavailable`, over HTTP `503 files_unavailable`; once the endpoint back, the tool line, then `File read.`; receive ordinals 1–7, each once; no diagnostic. |
| B6 | real: the bucket's endpoint stopped, connections refused | local | R1 | proven | Anchor `a770fd79…` → object `06fc11e1c3a2…`, its record's content null; restored, `groseille` recalled; the endpoint stopped: `execution.failed`, `restore_failed`. |
| B7 | — | local | R1 | proven | The owner: 200, `image/jpeg`; another owner: 404; an unknown digest: 404; `image/svg+xml` asked: `application/octet-stream`, `attachment`; `nosniff` on each. |
| B8 | simulated: forced-state (rows' times and objects' dates set as days had passed) | local | R1 | proven | Swept `{"rows":2,"orphans":1}`; three objects and three rows left: the referenced one, the recent one, the current anchor's. |
| B9 | simulated: forced-state (the log written inline by the provisioning login, as before the move) | local | R1 | proven | Moved `{"entries":3,"objects":1,"anchors":1,"files":3}`, the base64 of zeros among them; each entry expanded with the bytes R2 gives back equal to before, `9007199254740993` kept; then nothing more moved; three objects. |
| B10 | simulated: forced-state (the test holds the files lock exclusive, deletes the row and the object, as a sweep would) | local | R1 | proven | The writer waited for the lock; PutObject `200`, then `200` again after the sweep; the entry's `files` naming the object, which is there. |
| B11 | real: the bucket's endpoint stopped, connections refused | local | R1 | proven | Held while the endpoint was stopped, one prompt sent; then sent with `files` at `/params/prompt/0/data`, 300000 bytes; the agent: `an image, image/png, 300000 bytes, sha256 c74902354a4b.` |
| B12 | simulated: forced-state (the test holds the files lock shared, as a writer storing a file) | local | R1 | proven | While storing: `null`, nothing deleted, no DeleteObjects; after: `{"rows":0,"orphans":1}`. |

## Not covered

| Failure | Issue |
| --- | --- |
| The real R2: every case ran against the testkit's endpoint; R2 itself was tried by hand on 2026-11-08 (PutObject, `412`, `BadDigest`, ListObjectsV2, DeleteObjects, 30 MiB up in 3.3 s), not by a case. | #195 |
| R2 accepting a connection and never answering: requests give up after 5 s without a connection or 30 s without progress, twice; no case holds a request that long. | #195 |
| A database error while an anchor is read for a restore: it propagates, and the restore is tried again; no case produces it. | #195 |

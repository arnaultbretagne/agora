# Files

Contract to implement — Cloudflare R2 through its S3 API: PutObject with `If-None-Match` and
`x-amz-checksum-sha256`, GetObject, ListObjectsV2, DeleteObjects (each tried on `agora-files`,
2026-11-08); PostgreSQL **17**. Why: the files ADR. The log that holds the references: `log.md`.

**A file's bytes are stored once, in R2, under their SHA-256; entries, views and anchor records
hold references. Only Agora writes to R2.**

## Who does what

| Part | Role |
| --- | --- |
| `Files` (`@agora/log`) | Finds the files in an entry, stores their bytes, writes the references, expands them, serves a file, sweeps. |
| The bucket `agora-files` | One object per content. |
| PostgreSQL | The `files` table, each entry's `files`, each anchor's `file` (`log.md`, "Storage"). |
| The client | Fetches a file it shows from `GET /api/files/{sha256}` (`assistant-ui.md`, "Attachments"). |

## A file

| Source | What is a file |
| --- | --- |
| An entry's content: a command, an ACP line received or sent | Each string member, at any depth, of at least 65,536 characters that is base64 in its canonical form: the standard alphabet, padded, without line breaks, its decoded bytes encoding back to the same string. |
| A Pod's anchor | The whole body it pushes (`executions.md`, "Receiving an anchor"). |

Any other string stays in the entry as it is.

## Storing

| Step | Rule |
| --- | --- |
| Key | `sha256/` and the 64 lowercase hexadecimal digits of the SHA-256 of the bytes. |
| Upload | Unless a `files` row names the key: PutObject with `If-None-Match: *`, `x-amz-checksum-sha256` the bytes' SHA-256, type `application/octet-stream`. A `412` means the object is there: the file is stored; a `400 BadDigest`, that the bytes changed on the way: tried again. |
| Record | A `files` row — SHA-256, byte count, time — inserted unless it exists, in the transaction that writes the entry or the anchor record naming it. |
| Order | The bytes are stored in that transaction, before the entry or the record: a reference never names an object that is not stored. From its first look at `files` to the commit, the writer holds the files lock shared (a PostgreSQL advisory lock): no sweep runs in between. Rows are inserted in the order of their SHA-256. |
| R2 failing | A request gives up after 5 s without a connection or 30 s without progress, tried twice. A received line is not taken: the bridge holds the adapter, and the line is tried again as when PostgreSQL fails (`log.md`, "Backpressure and shutdown"), then written in its order. A Write is answered 503 `files_unavailable`, with nothing written. An anchor's push is answered 503, with nothing stored. |

## References

| Where | Form |
| --- | --- |
| In an entry | The string becomes `agora-file:sha256:` followed by the hexadecimal digest. The entry's `files` lists each one: its JSON Pointer in the content, its SHA-256, its byte count. |
| In a view | What the entry holds: the projector copies the string. |
| In an anchor record | `file`, the SHA-256 of the pushed body; the record holds no bytes. |
| Expanding | Each path the entry's `files` lists gets the base64 of its object back: the content as received or written, every member, number and string. A string at any other path is left as it is, even one that reads like a reference. |
| A line sent to a harness | The line expanded. An object R2 cannot give back fails the request locally: `request.failed`, `files_unavailable`. |

## Reading a file

| Route | Answer |
| --- | --- |
| `GET /api/files/{sha256}?type=T` | The object's bytes, streamed from R2, when an entry of one of the caller's Workstreams names it — the owner its identity gives, or `owner` without the proxy, as for the list (`log.md`, "HTTP"). Otherwise 404 `unknown_file`, the same for an object that does not exist. Type `T` when it is `image/jpeg`, `image/png`, `image/gif` or `image/webp`; any other, `application/octet-stream` with `Content-Disposition: attachment`. Always `X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=31536000, immutable`. |

## The sweep

| Rule | Detail |
| --- | --- |
| When | Once an hour, in the server, with the anchor role. It lists the bucket, then takes the files lock exclusive if it is free: while a file is being stored, it does not run, and waits for the next hour. |
| What | Under the lock: each `files` row more than 24 hours old that no entry's `files` and no anchor's `file` names is deleted, then its object (DeleteObjects); then each object listed (ListObjectsV2), last modified more than 24 hours ago, that has no row. |
| Nothing else | No other path deletes an object: deleting a Workstream or replacing an anchor removes references only. |

## The server

| Variable | Content |
| --- | --- |
| `FILES_ENDPOINT` | The account's S3 endpoint, `https://<account>.r2.cloudflarestorage.com`. |
| `FILES_BUCKET` | `agora-files`. |
| `FILES_ACCESS_KEY_ID`, `FILES_SECRET_ACCESS_KEY` | A token for that bucket alone, to read, write and delete objects. |

Without them, the server does not start. The sandboxes never reach the endpoint.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| B1 | A received tool update carrying a 4 MiB image as base64, in its content and its raw output | One object, at its bytes' key, stored by one PutObject; the entry holds `agora-file:sha256:<hex>` at both paths, and its `files` lists each path, the SHA-256 and the byte count; one `files` row; the entry expanded is the line received, every member, number and string; the tool's view holds the reference, not the bytes. |
| B2 | The same image in two lines, in two Workstreams; then in a third line once its `files` row is gone | One object. The first line's PutObject stores it; the second uploads nothing; the third's PutObject is answered 412 and the row is back. Each entry references it. |
| B3 | A base64 string of 65,532 characters; 1 MiB of base64 with a line break every 76 characters; `agora-file:sha256:` and an existing digest, in a person's text | All three left in the entry as they are; its `files` empty; the third reaches the harness as written. |
| B4 | A Write with a 500 KB JPEG attachment | The command and the `session/prompt` entry hold the reference; the line the bridge receives carries the base64, equal to the prompt written. |
| B5 | R2 unreachable: a received line with a file, then a line without one; a Write with an attachment; then R2 back | The Write answered 503 `files_unavailable`, no command entry. Both lines written once R2 answers, in their order, each once; no line lost from the adapter. |
| B6 | A Pod pushes its anchor; a later Create restores it; then, R2 unreachable, another Create | One object at the body's SHA-256; the anchor record's `file` names it and holds no bytes; the native files placed are those pushed, the agent recalling the earlier exchange. The last Create's execution fails `restore_failed`. |
| B7 | `GET /api/files/{sha256}` by the owner with `type=image/jpeg`; by another owner; for an unknown digest; by the owner with `type=image/svg+xml` | 200 with the bytes and `image/jpeg`; 404 `unknown_file`; 404 `unknown_file`; 200, `application/octet-stream` and `attachment`. Each with `nosniff`. |
| B8 | The sweep, with an object referenced; one unreferenced, stored an hour ago; one unreferenced, stored two days ago; the object of an anchor since replaced, and the current anchor's, both stored two days ago; an object with no row, two days old | Kept; kept; deleted with its `files` row; the replaced anchor's deleted, the current one's kept; deleted. |
| B10 | A line referencing a file already stored, written while a sweep that would delete it holds the files lock | The writer waits for the sweep; the object is stored again, and the entry's reference names an object that exists. |
| B11 | A message with a file written during a turn, R2 unreachable when the turn ends; then R2 back | The message waits, nothing sent while R2 is unreachable; then it goes as the next turn, its line listing the file, the agent given those bytes. |
| B12 | A sweep while a file is being stored; then another once it is stored | The first does not run: nothing deleted, no DeleteObjects. The second deletes the object nothing references. |
| B9 | A log written with files inline — an image in a command, a line and a view, base64 of zeros that PostgreSQL compresses to almost nothing, an anchor — moved to R2; then moved again | Each entry expanded, with the bytes R2 gives back, equals its former content, a number beyond 2^53 included; each anchor's object equals its former bytes; no base64 string of 64 KiB or more left in `entries` or `objects`; one object per distinct SHA-256. The second move moves nothing. |

## To be specified

| Point | Where it stands |
| --- | --- |
| A file inside a `data:` URL | Left in the entry. |
| How the thread shows a file a tool returned | As the tool's output gives it: its reference. |
| An anchor's size limit and compression | 32 MiB, unchanged (`executions.md`). |
| Handing a file to a delegate | By its reference; not offered yet. |

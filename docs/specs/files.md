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
| Order | The bytes are stored before that transaction: a reference never names an object that is not stored. From its first look at `files` to that commit, the writer holds the files lock shared (a PostgreSQL advisory lock): no sweep runs in between. |
| R2 failing | A received line is not taken: the bridge holds the adapter, and the line is tried again each second, then written in its order. A Write is answered 503 `files_unavailable`, with nothing written. An anchor's push is answered 503, with nothing stored. |

## References

| Where | Form |
| --- | --- |
| In an entry | The string becomes `agora-file:sha256:` followed by the hexadecimal digest. The entry's `files` lists each one: its JSON Pointer in the content, its SHA-256, its byte count. |
| In a view | What the entry holds: the projector copies the string. |
| In an anchor record | `file`, the SHA-256 of the pushed body; the record holds no bytes. |
| Expanding | Each path the entry's `files` lists gets the base64 of its object back: the content as received or written, byte for byte. A string at any other path is left as it is, even one that reads like a reference. |
| A line sent to a harness | The line expanded. An object R2 cannot give back fails the request locally: `request.failed`, `files_unavailable`. |

## Reading a file

| Route | Answer |
| --- | --- |
| `GET /api/files/{sha256}?type=T` | The object's bytes, streamed from R2, when an entry of one of the caller's Workstreams names it — the owner its identity gives, or `owner` without the proxy, as for the list (`log.md`, "HTTP"). Otherwise 404 `unknown_file`, the same for an object that does not exist. Type `T` when it is `image/jpeg`, `image/png`, `image/gif` or `image/webp`; any other, `application/octet-stream` with `Content-Disposition: attachment`. Always `X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=31536000, immutable`. |

## The sweep

| Rule | Detail |
| --- | --- |
| When | Once an hour, in the server, holding the files lock exclusive: no file is being stored meanwhile. |
| What | Each `files` row more than 24 hours old that no entry's `files` and no anchor's `file` names is deleted, then its object (DeleteObjects). Then each object of the bucket with no row (ListObjectsV2), last modified more than 24 hours ago, is deleted. |
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
| B1 | A received tool update carrying a 15 MB image as base64 | One object, at its bytes' key; the entry holds `agora-file:sha256:<hex>` at that path, and its `files` lists the path, the SHA-256 and the byte count; one `files` row; the entry expanded equals the line received, byte for byte. |
| B2 | The same image in two lines, in two Workstreams | One object: one PutObject stores it, the other is answered 412; one `files` row; both entries reference it. |
| B3 | A base64 string of 65,532 characters; 1 MiB of base64 with a line break every 76 characters; `agora-file:sha256:` and an existing digest, in a person's text | All three left in the entry as they are; its `files` empty; the third reaches the harness as written. |
| B4 | A Write with a 500 KB JPEG attachment | The command and the `session/prompt` entry hold the reference; the line the bridge receives carries the base64, equal to the prompt written. |
| B5 | R2 unreachable: a received line with a file, then a line without one; a Write with an attachment; then R2 back | The Write answered 503 `files_unavailable`, no command entry. Both lines written once R2 answers, in their order, each once; no line lost from the adapter. |
| B6 | A Pod pushes its anchor; a later Create restores it | One object at the body's SHA-256; the anchor record's `file` names it and holds no bytes; the body placed by `PUT /anchor` equals the one pushed. |
| B7 | `GET /api/files/{sha256}` by the owner with `type=image/jpeg`; by another owner; for an unknown digest; by the owner with `type=image/svg+xml` | 200 with the bytes and `image/jpeg`; 404 `unknown_file`; 404 `unknown_file`; 200, `application/octet-stream` and `attachment`. Each with `nosniff`. |
| B8 | The sweep, with an object referenced; one unreferenced, stored an hour ago; one unreferenced, stored two days ago; the object of an anchor since replaced, stored two days ago; an object with no row, two days old | Kept; kept; deleted with its `files` row; deleted, the current anchor's object kept; deleted. |
| B10 | A line referencing a file already stored, written while a sweep that would delete it holds the files lock | The writer waits for the sweep; the object is stored again, and the entry's reference names an object that exists. |
| B9 | A log written with files inline, moved to R2 | Each entry expanded equals its former content; each anchor's object equals its former bytes; no base64 string of 64 KiB or more left in `entries` or `objects`; one object per distinct SHA-256. |

## To be specified

| Point | Where it stands |
| --- | --- |
| A file inside a `data:` URL | Left in the entry. |
| How the thread shows a file a tool returned | As the tool's output gives it: its reference. |
| An anchor's size limit and compression | 32 MiB, unchanged (`executions.md`). |
| Handing a file to a delegate | By its reference; not offered yet. |

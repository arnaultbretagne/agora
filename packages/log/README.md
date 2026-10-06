# log

The Workstream log (`docs/specs/log.md`): commands, every ACP line, dispatch and capture, recovery,
the views and the thread, in PostgreSQL. It mounts the execution mechanics of
`@agora/executions` and decides everything they do.

| Path | Content |
| --- | --- |
| `src/workstreams.ts` | `Workstreams`: admission, dispatch, capture, recovery, deadlines, anchors; the mechanics' handler. |
| `src/store.ts` | Entries, commands, Sessions, diagnostics and anchors, behind the three roles. |
| `src/acp.ts` | Validation of a line against the pinned ACP schema. |
| `src/state.ts` | The fold of the entries: executions, requests, turns; the core projector. |
| `src/catch-up.ts` | Continuing a Workstream: the anchor a Create restores, and the exchanges given as text with the first prompt. |
| `src/projection.ts` | Views, checkpoints, rebuilds and the thread. |
| `src/http.ts` | The HTTP routes. |
| `src/telemetry.ts` | The operational logger. |
| `sql/001.sql` | The schema and the three roles. |
| `scripts/` | Migration and login provisioning. |
| `test/` | One test per acceptance case, on PostgreSQL 17, real bridges and the real lab process. |

Provision a database: `scripts/README.md`. The server is given the three runtime URLs only.

Tests: `npm test -w @agora/log`. They need a PostgreSQL 17 server: `LOG_TEST_ADMIN_URL` names a
login that may create databases and roles, or, without it, the local server is used through
`sudo -u postgres`. Each run creates a template database and three logins, each test a database
of its own, and drops them all. `node test/run.ts test/lines.test.ts --test-name-pattern='^L3 '`
runs one file, or one case.

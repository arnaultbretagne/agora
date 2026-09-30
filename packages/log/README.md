# log

Agora's immutable Workstream journal, mounted by the admin lab when its three PostgreSQL
runtime URLs are configured. The contract is in `docs/specs/log.md`.

| Path | Responsibility |
| --- | --- |
| `src/store.ts` | Canonical transactions, admission deduplication, raw ACP capture, Session attribution, anchor publication. |
| `src/acp.ts` | ACP 1.5.1 method schemas, direction matrix and lossless JSON validation. |
| `src/state.ts` | Canonical admission state and deterministic turns, chunks, tools, plans, permissions and notices. |
| `src/projection.ts` | Atomic views/checkpoints, coordinated version rebuilds and decimal-cursor snapshot/tail. |
| `src/driver.ts` | Exclusive driving, claim recovery, bridge capture/backpressure, dispatch markers, cancellation, renewal and drain. |
| `src/http.ts` | Admin lab commands and resumable SSE thread. Product authorization belongs to its separate access contract. |
| `src/telemetry.ts` | Validated correlations and closed operation/outcome/error classes; no payloads or exception messages. |
| `sql/001.sql` | Schema and the three NOLOGIN boundary roles. |
| `scripts/migrate.ts` | Privileged provisioning, separate from the runtime. |
| `test/` | Isolated PostgreSQL databases, actual restricted logins, real mock bridges, fault injection and Chromium. |

Provision a UTF-8 PostgreSQL 17 database with `node packages/log/scripts/migrate.ts`. Supply
`LOG_MIGRATION_URL` for the schema owner and `LOG_WRITER_URL`, `LOG_PROJECTOR_URL`,
`LOG_ANCHORS_URL` for three distinct restricted logins in that database. New logins are
provisioned by the script; existing login passwords are not changed. The application receives
only the three runtime URLs. It rejects owners, superusers, privileged memberships and mixed
boundary roles. Configure `LAB=true` to expose the log lab API and page.

`npm run check` runs the database and browser cases. Set `LOG_TEST_ADMIN_URL` to a disposable
PostgreSQL server's provisioning login. Without it, the runner can provision through the local
PostgreSQL peer administrator via sudo. Each run creates and drops its own database and
runtime logins. Install the pinned Chromium with `npx playwright install chromium` (CI installs
its system dependencies too). No application operation in the tests uses the provisioning
login; it is used only for migrations, test fault triggers and fixture setup.

The database advisory lock admits one driver per database. Losing that connection closes its
bridges and stops the driver; restart recovers its journal and records unclean breaks. A
second driver cannot start while the first owns the lock. The bridge also permits one peer.
These are dispatch ownership controls, not proof of physical extinction for a replacement.
Create after execution loss is refused until an execution end has been recorded.

The projector refolds canonical entries through one source position and publishes only changed
objects. It deliberately keeps its folding state out of PostgreSQL; the cost grows with retained
history. Version rebuilds refold every registered projector in the same transaction and refuse
publication when a stored projector is absent from the registry. There is no retention policy.

The old implementation informed method-specific ACP validation, immutable positions and
column grants, UUIDv5 identities, sparse tool updates, canonical hashes and allow-list telemetry.
The new dispatcher uses accepted commands and Agent Sandbox deadlines. It does not carry over
Intent/Observation reconciliation, Saves, W/H frontiers, refills, OneCLI or annotation memory.

Measurements in `docs/specs/log.md` distinguish PostgreSQL/mock/browser results and injected
faults from whole-server failure, SIGKILL, real Claude transcripts and the assistant-ui client.
The lab is a diagnostic surface; production identity, replacement proof, model readback,
retention and history seeding remain separate contracts.

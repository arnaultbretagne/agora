# test

One test per acceptance case of `docs/specs/log.md` (L…), and the cases of
`docs/specs/executions.md` the log decides (E…), each named by its ID
(`docs/reliability/README.md`).

| File | Cases |
| --- | --- |
| `lines.test.ts` | What a received line becomes: L1–L3, L5, L26. |
| `commands.test.ts` | Admission, Cancel, Stop, permissions: L6, L9, L10, L12–L14, L16, L37. |
| `turns.test.ts` | A turn across failures: L4, L7, L11, L33–L35, L40, L41. |
| `recovery.test.ts` | Agora stopped, killed, cut from PostgreSQL; the claim and the bridge against the record: L8, L15, L17–L21, L29–L32, L36, L38, L39. |
| `views.test.ts` | Folds, rebuilds, the thread, the Workstream view and list, the Session notices: L22–L24, L42–L46. |
| `storage.test.ts` | Roles and migrations: L25, L27. |
| `telemetry.test.ts` | The operational logs: L28. |
| `executions.test.ts` | E3, E4, E12, E13. |
| `credentials.test.ts` | The execution's token before `initialize`, its renewal, the Create's profiles, those offered: C10, C12, C14, C20. |
| `settings.test.ts` | A Session's settings and commands, Configure, the catalogue's: L47–L53. |
| `scope.test.ts` | Scope and the token that follows it, across a restart: C17–C19, C21, L54, L55. |
| `restore.test.ts` | An anchor placed before `initialize`, onto an adapter restarted to read it: E29. |
| `continuing.test.ts` | A Workstream continued: the anchor found by harness, the exchanges it lacks given with the first prompt, a command left alone, the length bound, a restore refused: L57–L64. |
| `support.ts` | A database per test; Agora in this process (`Lab`) or as the real lab process (`Server`); relays that cut a bridge connection or lose a COMMIT's reply. |
| `run.ts` | Provisions the template database and the three logins, runs the tests four files at once (`LOG_TEST_CONCURRENCY`, 1 for one by one), removes everything. |
| `fixtures/` | The histories the tests replay. |

The failures are real wherever the level allows — a process killed, a connection terminated by
PostgreSQL, a socket cut, an adapter dead; otherwise the test names its mechanism.

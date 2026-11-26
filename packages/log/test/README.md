# test

One test per acceptance case of `docs/specs/log.md` (L…), and the cases of
`docs/specs/executions.md` the log decides (E…), each named by its ID
(`docs/reliability/README.md`).

| File | Cases |
| --- | --- |
| `lines.test.ts` | What a received line becomes: L1–L3, L5, L26. |
| `commands.test.ts` | Admission, Cancel, Stop, permissions: L6, L9, L10, L12–L14, L16, L37. |
| `turns.test.ts` | A turn across failures: L4, L7, L11, L33–L35, L40, L41. |
| `recovery.test.ts` | Agora stopped, killed, cut from PostgreSQL; the claim and the bridge against the record: L8, L15, L17–L21, L29–L32, L36, L38, L39, L77. |
| `views.test.ts` | Folds, rebuilds, the thread, the Workstream view and list, the Session notices: L22–L24, L42–L46. |
| `questions.test.ts` | A question to the person: Ask, Answer, and what they hold back: L69–L74. |
| `elicitations.test.ts` | A form an agent asks: declared, pending, answered once, refused when it does not fit, cancelled, declined by Agora, withdrawn, rebuilt at an upgrade, checked against its schema, a check that cannot complete refusing it: L160–L172. |
| `requests.test.ts` | A request an agent waits on — a permission — in its view, its row and the rows above it; who answered it: L154–L156. |
| `notifications.test.ts` | Notifications (`docs/specs/notifications.md`): what notifies, the message and its encryption, sending and retries, subscriptions, the configuration: N1–N11. |
| `accounts.test.ts` | The caller's account and its list, on the real server, with IDENTITY `none`: L75, L76. |
| `identity.test.ts` | Who calls the real server with IDENTITY `oidc`: an issuer's ID token, service tokens, what proves nobody, the issuer out of reach, a configuration refused: L173–L178. |
| `ownership.test.ts` | What a caller reaches on the real server: its own Workstreams, files, anchors, executions and events, another owner's answered as none, with IDENTITY `oidc`; with `none`, as before: L179–L184. |
| `storage.test.ts` | Roles and migrations: L25, L27. |
| `telemetry.test.ts` | The operational logs: L28. |
| `executions.test.ts` | E3, E4, E12, E13. |
| `lifetime.test.ts` | How long a sandbox lives, side by side on a 60 s lease: a turn past the turn cap a Create names, work left running after the turn, the ceiling, nothing left running, the Create's own message starting a command, a message taken into a running turn: E14, E36–E38, E40, E41. |
| `deadline.test.ts` | The deadline's and the token's arithmetic over six hours with production's values, and work told from the harness by the bridge's listings: C81, E40. |
| `credentials.test.ts` | The execution's token before `initialize`, its renewal before a prompt and while its sandbox outlives it, the Create's profiles, those offered, the MCP servers they open: C10, C12, C14, C20, C43, C81. |
| `settings.test.ts` | A Session's settings and commands, Configure, the catalogue's, a pool's first Session: L47–L53, L185. |
| `scope.test.ts` | Scope and the token that follows it, across a restart and its pool replaced: C17–C19, C21, C76–C78, L54, L55. |
| `restore.test.ts` | An anchor placed before `initialize`, onto an adapter restarted to read it: E29. |
| `files.test.ts` | Files in R2: references, the bucket failing, anchors, the route, the sweep, the move: B1–B10. |
| `continuing.test.ts` | A Workstream continued: the anchor found by harness, the exchanges it lacks given with the first prompt, a command left alone, the length bound, a restore refused: L57–L64. |
| `support.ts` | A database per test; Agora in this process (`Lab`) or as the real lab process (`Server`); relays that cut a bridge connection or lose a COMMIT's reply; signers whose grants an MCP server takes, and a stand-in for the gateway's route `agora` where the mock agent calls it. |
| `run.ts` | Provisions the template database and the three logins, runs the tests four files at once (`LOG_TEST_CONCURRENCY`, 1 for one by one), removes everything. |
| `fixtures/` | The histories the tests replay. |

The failures are real wherever the level allows — a process killed, a connection terminated by
PostgreSQL, a socket cut, an adapter dead; otherwise the test names its mechanism.

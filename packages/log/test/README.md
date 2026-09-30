# measurements

`run.ts` provisions an isolated database and three real restricted logins, then removes them.
`log.test.ts` measures the log against PostgreSQL 17, actual mock bridges, fault injection and
Chromium. Case names refer to L1–L30 in `docs/specs/log.md`; that document records the scope of
each measurement and the acceptance cases that still require another environment or client.

The opt-in `measure:claude` command uses `scripts/live-claude.ts` against real infrastructure.
The captured Claude fixture also runs in ordinary checks, without a model call or credential.

# measurements

`run.ts` provisions an isolated database and three real restricted logins, then removes them.
`log.test.ts` measures the log against PostgreSQL 17, actual mock bridges, fault injection and
Chromium. Case names refer to L1–L30 and L37–L41 in `docs/specs/log.md`; that document records the scope of
each measurement and the acceptance cases that still require another environment or client.

Lifecycle regressions cover delayed foreground deletion, finalizing lost executions, quota
retention, actual lab JWT signing and a mock termination-hook HTTP anchor push across a driver
restart without ACP. TokenReview is stubbed by FakeKube. Duplicate opening answers retain their
original Session and apply once. Configuration cases L31–L36 remain unmeasured.

The opt-in `measure:claude` command uses `scripts/live-claude.ts` against real infrastructure.
The captured Claude fixture also runs in ordinary checks, without a model call or credential.

# provisioning

`migrate.ts` applies `sql/001.sql` as the database owner (`LOG_MIGRATION_URL`). With
`LOG_PROVISION_LOGINS=true` it also creates the three runtime logins named in `LOG_WRITER_URL`,
`LOG_PROJECTOR_URL` and `LOG_ANCHORS_URL`, from SCRAM verifiers; where the platform manages them, it
only checks their boundaries. `scram.ts` builds the verifiers.

```sh
LOG_MIGRATION_URL=postgresql://<owner>@<host>/<db> \
LOG_WRITER_URL=… LOG_PROJECTOR_URL=… LOG_ANCHORS_URL=… \
node packages/log/scripts/migrate.ts
```

It prints `log schema ready`, or exits non-zero.

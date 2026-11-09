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

`move-files.ts` moves the files already in the database to R2, once (`docs/specs/files.md`, B9): as the
database owner, with the files' bucket and the schema applied; the server may run, a view it changes
meanwhile being left for a second run. Each entry's files
become references, each checked to expand back to what was stored; the views' files too; each anchor's
bytes become its object. A second run moves only what is left. Then `VACUUM (FULL)` gives the space back.

```sh
LOG_MIGRATION_URL=postgresql://<owner>@<host>/<db> \
FILES_ENDPOINT=… FILES_BUCKET=agora-files FILES_ACCESS_KEY_ID=… FILES_SECRET_ACCESS_KEY=… \
node packages/log/scripts/move-files.ts
```

It prints what it moved, then `files moved`, or exits non-zero.

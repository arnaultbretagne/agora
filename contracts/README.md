# Contracts

Machine-readable boundaries between deployables (ADR 0001): database schema, APIs, schemas and
policies. Each contract is introduced by the implementation slice that specifies its behavior.

- `db/schema.sql` — the PostgreSQL schema, applied from scratch (no migrations before first release).

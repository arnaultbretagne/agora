# ADR 0007 — Custody is opaque, versioned Session state

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Native resume requires harness state such as Claude JSONL or Codex state. Parsing it in Agora would
couple product history to unstable formats; retaining a PVC per Session would couple durable resume
to a Pod volume.

## Decision

Harness-specific drivers capture and restore immutable custody snapshots. Core code sees bytes plus
format/version/checksum/size/watermark metadata and never parses payloads.

The baseline stores bounded payloads in a restricted Postgres `bytea` column. Capture completes
before Anchor advancement and intentional Pod deletion.

## Alternatives rejected

- **PVC per Session:** expensive lifecycle and backup complexity.
- **JSONB transcript model:** falsely makes native state a product contract.
- **Use product journal as native resume state:** cannot restore hidden harness context.
- **Let the application read custody:** breaks concern and secret boundaries.

## Consequences

- Separate database roles and audited payload access are required.
- Drivers must exclude credentials and declare compatibility.
- Object storage remains a future backend option behind the same interface.
- A corrupted/incompatible snapshot causes explicit resume failure.

## Governing specs

- [Custody](../specs/07-custody.md)

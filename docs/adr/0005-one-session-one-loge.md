# ADR 0005 — One Session equals one logical Loge

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Reusing a Loge for a Workstream or group made equipment replacement, placement, process ownership and
resume indirect. Strict Session/runtime identity removes lookup maps and accidental state sharing.

Kubernetes Pods are ephemeral, while ACP Sessions may be resumed after a Pod is deleted.

## Decision

Each Agora Session owns exactly one logical Loge identified by the same Agora Session ID. A Loge may
have zero or one active Pod incarnation. Rematerializing after suspension may produce a new Pod UID
without creating another Loge or Session.

The Loge controller exposes idempotent resource operations keyed by Session ID. It never accepts a
group or reuses a Pod for another Session.

## Alternatives rejected

- **Loge per Workstream:** couples several Agent Sessions/security envelopes.
- **Reusable pool Pod:** weakens isolation and custody ownership.
- **Treat every Pod incarnation as a new Session:** makes ACP native resume impossible.
- **Persist a separate Loge entity:** creates a permanent 1:1 alias without additional meaning.

## Consequences

- Pod naming/labels and reconciliation become deterministic.
- One active Pod per Session is a hard invariant and alert.
- Physical Pod status remains infrastructure state.
- Custody is required before intentional dematerialization.

## Governing specs

- [Session lifecycle](../specs/03-session-lifecycle.md)
- [Loge control](../specs/08-loge-control.md)

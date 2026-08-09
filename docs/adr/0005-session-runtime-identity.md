# ADR 0005 — Session Runtime has Session identity

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

The first greenfield draft called the isolated runtime a `Loge`. That metaphor is not self-evident
in an English codebase and makes a strict 1:1 Session subresource sound like an independent domain
object.

Reusing a runtime for a Workstream or group previously made equipment replacement, placement,
process ownership and resume indirect. Giving the new 1:1 runtime alias its own identity would
instead preserve two identifiers for the same lifecycle.

Kubernetes Pods are ephemeral, while ACP Sessions may be resumed after a Pod is deleted.

## Decision

`SessionRuntime` names the isolated infrastructure aspect of a Session; it is not a persisted
entity. Every Session has exactly one Session Runtime lifecycle, addressed only by the Agora Session
ID, with zero or one active Pod incarnation.

Rematerializing after suspension may produce a new Pod UID without creating another Session or
runtime identity. The Session Runtime controller exposes idempotent operations under the Session
resource. It never accepts a runtime ID/group or reuses a Pod for another Session.

The Broker applies the same grain to OneCLI: one dedicated selective OneCLI Agent per Session. The
OneCLI Agent may survive Pod replacement for that same Session, but is rotated/revoked while its
Session Runtime is not materialized and is never reassigned.

## Alternatives rejected

- **Keep `Loge` as a branded code term:** requires every contributor and API consumer to learn an
  otherwise unnecessary metaphor.
- **Use unqualified `Runtime`:** collides with immutable Agent runtime definitions and runtime
  versions.
- **Expose no runtime term at all:** conflates durable Session/ACP state with live infrastructure
  materialization and status.
- **Runtime per Workstream:** couples several Agent Sessions/security envelopes.
- **Reusable pool Pod:** weakens isolation and custody ownership.
- **Treat every Pod incarnation as a new Session:** makes ACP native resume impossible.
- **Persist a separate Session Runtime entity:** creates a permanent 1:1 alias without additional
  meaning.
- **Share one OneCLI Agent across Sessions:** couples credentials, policy and revocation across
  otherwise isolated Session Runtimes.

## Consequences

- Pod naming/labels and reconciliation become deterministic.
- One active Pod per Session is a hard invariant and alert.
- Physical Pod status remains infrastructure state.
- Custody is required before intentional dematerialization.
- Session cleanup includes deterministic OneCLI Agent revocation and eventual deletion.

## Governing specs

- [Session lifecycle](../specs/03-session-lifecycle.md)
- [Session Runtime control](../specs/08-session-runtime-control.md)

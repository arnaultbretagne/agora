# ADR 0004 — ACP is the harness boundary and complete envelopes are Session facts

- **Status:** Accepted
- **Date:** 2026-08-13
- **Revised:** 2026-09-05 — observation and attribution requirements for supported harnesses.

## Context

Agora must interact with several harnesses without making product behavior depend on their native
commands, transcripts, file formats or process interfaces.

The product needs one structured protocol for:

- creating and configuring an execution context;
- sending prompts and receiving streamed content;
- tool calls and results;
- plans;
- permission requests;
- cancellation and protocol errors;
- harness capabilities and configuration.

Agora must also retain what was actually exchanged during an execution.

The protocol stream and the readable product model do not have the same shape. ACP carries complete
JSON-RPC envelopes and incremental updates, while product readers need assembled messages, current
tool-call state, plans, permission interactions and prompt turns.

Flattening the protocol before persistence would lose information. Treating transport bytes as
product history would preserve details that have no ACP meaning while coupling the record to one
framing and serialization.

The protocol choice and the persistence choice are therefore one architectural decision. Choosing
ACP as the semantic boundary only remains useful if Agora preserves the complete ACP meaning that
crossed that boundary.

## Decision

### ACP is the only harness semantic protocol

Agora uses stable ACP v1 as the only semantic protocol between the product and every harness
integration.

Agora implements the ACP Client role. Each harness integration exposes the ACP Agent role using the
official pinned SDK and protocol schema.

`Client` and `Agent` here are ACP protocol roles. They do not introduce additional Agora domain
identities. Agora calls the selected integration a `harness`.

Core product code uses ACP methods and types unchanged. It does not define a smaller Agora protocol,
rename ACP concepts or translate ACP envelopes into local wire messages.

A harness adapter may translate between ACP and the native interface of its harness. That
translation remains behind the ACP boundary and cannot introduce harness-native semantics into the
product core.

A remote bridge may authenticate, frame, validate, capture and transport ACP data. It must not
create another semantic protocol or reinterpret ACP meaning.

ACP does not define Agora persistence, remote transport, runtime ownership or universal save and
restore behavior. Those remain separate concerns.

An enabled harness integration must demonstrate the fresh reads required by reconciliation.
Configuration responses/notifications are evidence only under a verified live connection and
context incarnation; a persisted response is historical. Native continuity readback belongs to the
reviewed custody driver and never introduces native transcript parsing into the product core or a
custom ACP method. Readback is an integration contract, not a guarantee inferred from ACP support.

An incompatible ACP version requires a separate decision and migration plan. A draft protocol
version is not a production storage contract.

### Capture occurs at the complete-envelope boundary

Transport chunks are arbitrary delivery fragments. They are not Session facts and are not
persisted.

The capture seam sits where one complete serialized ACP JSON-RPC envelope has been framed, but
before that envelope is semantically handled or sent:

```text
Agora → harness

ACP operation
      │
      ▼
complete serialized envelope
      │
      ▼
validate → append Session fact → COMMIT
                                      │
                                      ▼
                               transport write


harness → Agora

transport chunks
      │
      ▼
complete serialized envelope
      │
      ▼
validate → append Session fact → COMMIT
                                      │
                                      ▼
                                ACP handling
```

Acceptance is validated against the negotiated, pinned ACP contract. Validation is specific to
message kind, direction and method or correlated response. It validates without replacing the
captured value with a normalized local object.

Each accepted envelope occurrence is appended once as an immutable Session fact. Requests,
responses, errors and notifications are included in both directions.

Two identical envelopes may represent two legitimate occurrences. Content equality is therefore
not a deduplication key. Recovery and replay use an explicit stable observation or dispatch identity
defined by the normative specification.

Malformed, oversized, unauthenticated or protocol-invalid frames are not canonical ACP facts. A
safe operational diagnostic may retain their direction, error class, size and digest, but not their
content.

### The canonical value is semantic JSON, not transport bytes

The persisted value is the complete accepted JSON-RPC envelope as semantic JSON:

- every accepted member and value is preserved;
- array order is preserved;
- accepted members unknown to the current projector are preserved;
- unknown `_meta` members are preserved;
- integer values, including values outside the JavaScript safe-integer range, are preserved without
  rounding.

The canonical insertion path must not parse and reserialize the envelope through an IEEE-754
JavaScript `number` before persistence. Validation and SDK handling must not replace the losslessly
captured value with a normalized local object.

Exact transport bytes are not canonical. JSON whitespace, object-member order, escape spelling,
numeric literal spelling and the framing delimiter have no ACP meaning and may be normalized by
storage.

In this ADR, capture at the “raw frame” seam means that no semantic projection occurs before append.
It does not mean byte-for-byte packet storage.

### ACP envelopes are Session facts ordered by the Workstream

Every canonical ACP fact:

- references exactly one `session_id`;
- belongs to that Session's Workstream order;
- records its direction;
- stores the complete envelope;
- carries only the minimal metadata required for ordering, correlation, causation and
  deduplication.

There is no separate ACP journal and no copied Session journal. An ACP envelope is one kind of fact
in the canonical Workstream fact stream. Reading ACP history for a Session means selecting the facts
with that `session_id`.

The Workstream sequence is the canonical order chosen when Agora durably accepts facts. A
Session-local sequence may support efficient Session reads, but it does not create a second history.
Wall-clock timestamps describe facts and do not order them.

Ordering across the two protocol directions is Agora's durable acceptance order, not a claim about
an unknowable physical network order. Within each direction, framing and commit preserve the
observed order.

For an outgoing envelope, the committed fact means:

> This envelope was durably scheduled for dispatch.

It does not prove that the harness received or handled it. No transport write occurs before the
fact commits.

For an incoming envelope, the committed fact means:

> This envelope was observed and durably accepted.

It does not prove that subsequent product handling completed. The fact commits before semantic
handling and before any acknowledgement whose emission Agora controls.

A Session identity must exist when concrete execution begins and before its first ACP envelope is
scheduled or accepted. Reaching a usable or converged state is not a prerequisite: a Session may log
a bootstrap attempt that fails. An Intent superseded before any concrete execution begins still
produces no Session.

The lifecycle specification defines the exact Session boundary around bootstrap, resume and
effective configuration changes. It must never leave a canonical ACP envelope without a Session.

### Readable models are projections

Messages, thoughts, tool calls, plans, permission interactions, prompt turns and other readable
product structures are deterministic projections of canonical ACP facts.

A projector may:

- assemble streamed content;
- fold several updates into current entity state;
- correlate requests and responses;
- create projection-only fallback keys where ACP omits an identifier;
- expose an accepted but unsupported envelope as a generic inspectable item.

A projection may not rewrite, complete or discard the canonical envelope. Missing optional ACP
fields remain missing.

Projections are disposable, checkpointed and rebuildable from Workstream-ordered facts. Projected
records retain references to their source facts. A projector change requires a version bump and
rebuild, not a mutation of canonical history.

UI presentation may collapse or filter information. Persistence does not.

### Saves and operational telemetry remain separate

A save contains opaque harness state, not ACP product meaning. Its bytes are not stored inside an
ACP envelope or ACP projection.

A save is an immutable record linked to the Session that produced it. If a later Session restores
that save, the restoration is a fact of the later Session referencing the save. The save itself is
never updated with a consumer or `restored_into` relation.

Runtime telemetry, gateway request logs and security audit records are not ACP exchanges and do not
become ACP Session facts.

## Why this choice

This design provides one protocol boundary and one faithful account of what crossed it:

- **Harness independence:** product semantics do not depend on a native CLI, transcript or file
  format.
- **Shared semantics:** prompts, updates, tools, plans and permissions keep their ACP meaning across
  harnesses.
- **Complete history:** information unknown to today's product remains available tomorrow.
- **Honest attribution:** every accepted exchange belongs to the Session during which it occurred.
- **Stable ordering:** exchanges from successive Sessions share one Workstream order.
- **Crash safety:** an envelope becomes durable before Agora sends it or acts on it.
- **Readable product state:** projections serve product reads without becoming a second truth.
- **Correctable interpretation:** projection defects can be fixed and replayed without changing
  history.

The central statement of this decision is:

> ACP defines the harness boundary; complete envelopes are immutable Session facts; readable models
> are rebuildable projections.

## Options considered

### 1. Integrate each harness through its native interface

Rejected because every harness would bring different lifecycle, streaming, tool, permission and
error semantics into the product core.

Native interfaces remain an adapter concern behind ACP.

### 2. Drive harness terminals or parse text transcripts

Rejected because terminal output does not reliably express structured content, tool state, plans,
permissions, cancellation or protocol errors.

It also makes product behavior depend on presentation intended for a human terminal.

### 3. Normalize ACP into an Agora protocol

Rejected because Agora would own a second semantic protocol and continuously translate between the
two.

The local protocol would either lag ACP or discard fields it did not model. Its normalized messages
would become an ambiguous second truth.

### 4. Store only typed SDK objects or the readable product model

Rejected because parsing and flattening can remove unknown members, round large integers and lose
the original sequence of incremental updates.

Assembled messages and current-state rows cannot reconstruct the accepted ACP exchange.

### 5. Store exact transport bytes as canonical history

Rejected because chunk boundaries, whitespace, object-member order and framing delimiters are
transport details, not ACP semantics.

Byte storage would make equivalent JSON envelopes appear different and couple durable history to
one transport encoding.

### 6. Build product reads directly from canonical envelopes

This preserves the truth but repeatedly performs complex folds at read time and makes every reader
implement ACP assembly rules.

Rebuildable projections provide efficient reads while keeping the complete envelope canonical.

### 7. Keep protocol selection and canonical capture as unrelated decisions

Rejected because ACP was selected precisely for its structured semantics. Allowing each integration
to persist a reduced or normalized view would discard those semantics and recreate harness-specific
behavior above the protocol boundary.

### 8. Adopt a draft ACP version

Rejected because the protocol envelope is also a durable storage contract. An unstable version may
change both runtime behavior and retained history without a controlled migration.

## Consequences

- Every harness integration must expose stable ACP v1.
- The official ACP SDK and schema are pinned architectural dependencies.
- The capture seam must exist below semantic handling in both directions.
- Canonical persistence must preserve accepted unknown members and lossless JSON numbers.
- Durable append adds database-write latency and backpressure to every accepted envelope.
- Recovery requires explicit dispatch, replay and occurrence-deduplication rules.
- Projection code must be deterministic, idempotent, versioned and rebuildable.
- Projection lag may affect freshness but never changes canonical history.
- Valid ACP content is product data and requires appropriate access control and retention. Bearer
  tokens and provider credentials are forbidden at this boundary.
- Exact schemas, sequence allocation, transaction boundaries, frame-size limits, retry
  classifications and projection folds belong in normative specifications.

## Governing specs

- [ACP facts and current evidence](../specs/reconciliation/execution.md#acp-facts-and-current-evidence)
- [Prompt delivery recovery](../specs/reconciliation/engine.md#prompt-delivery-and-context-creation)

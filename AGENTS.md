# Instructions for implementation agents

This file is normative for every coding agent working in this repository.

## Required reading

Before changing code, read:

1. `docs/specs/00-glossary.md`
2. `docs/specs/02-domain-model.md`
3. the complete specification governing the package being changed;
4. the ADRs referenced by that specification;
5. the assigned file under `plans/`.

Do not infer architecture from an implementation stub. Specifications and machine-readable contracts
take precedence over code. ADRs explain decisions but do not replace specifications.

## Forbidden concept drift

Do not introduce:

- `Conversation` as a domain aggregate;
- a `Run` entity or `run_id`;
- `Loge` or `loge_id`;
- a persisted `SessionRuntime` entity or `runtime_id`;
- a Session Runtime reusable by several Sessions;
- `native_session_id`;
- a harness `Thread` as an Agora aggregate;
- `kind` as a synonym for Agent;
- fixed combination profiles such as `repo-dev-vault`;
- a custom semantic protocol around ACP;
- application-owned infrastructure logs;
- parsed or normalized custody payloads.

The only accepted terms and meanings are in the glossary.

## Protocol rules

- Import ACP v1 types from `@agentclientprotocol/sdk`.
- Preserve complete ACP envelopes, including unknown `_meta` fields.
- Never duplicate or fork ACP request/update types in local contracts.
- A network bridge may frame or authenticate ACP bytes; it must not translate ACP semantics.
- ACP v2 is draft and must not enter production code without a new ADR.

## Persistence rules

- `product.workstream_events` is the canonical product journal.
- Projection tables must be disposable and rebuildable.
- Custody bytes are opaque and may only be accessed by the custody/runtime role.
- Infrastructure telemetry never belongs in the product journal.
- Every externally retried command must have an idempotency key.

## Security rules

- Browser input expresses resource intent, never raw capabilities or provider scopes.
- Only the policy service resolves intent into grants.
- Only the Session Runtime controller owns Kubernetes workload permissions.
- Provider secrets live only in OneCLI; its control key and upstream Agent bearer never enter a
  Session Runtime.
- OneCLI is the only credential gateway. Never build/port a parallel MITM, secret store, injector or
  provider adapter.
- Broker may implement only OneCLI control lifecycle and a workload-authenticated opaque relay; that
  relay must not terminate provider TLS, inspect provider content or inject credentials.
- Every Session uses one dedicated selective OneCLI Agent and explicit allows followed by `block *`.
- Agent images contain pinned harness/ACP binaries; Pods never install them at startup.
- Never persist bearer tokens, one-time ACP tunnel tokens or provider credentials in product,
  projection, custody or ACP data. The only exception is encrypted Broker-private upstream OneCLI
  authority required by ADR 0010; provider credentials remain OneCLI-owned.
- The public runtime API must not accept arbitrary commands, argv, environment variables or images.
- Gateway/process logs must omit URL query strings, headers, prompts, tool content and tokens.

## Delivery rules

- Work from one implementation plan at a time.
- Update that plan's checklist in the same change.
- Add contract and failure-path tests before marking a phase complete.
- Do not weaken an invariant to make a test pass.
- If a spec is ambiguous, stop and propose a spec/ADR change before coding divergent behavior.
- Keep changes scoped; do not implement a later plan opportunistically.

## Definition of done

A plan is complete only when:

- its stated contract tests pass;
- all acceptance scenarios are covered;
- observability correlation is present without leaking content or secrets;
- docs and schemas agree with the implementation;
- no placeholder or silent fallback remains.

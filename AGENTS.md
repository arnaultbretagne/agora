# Instructions for agents

This file is normative for every agent working in this repository.

## Architecture and documentation gate

Before reasoning about or changing architecture, vocabulary, ADRs, specifications or contracts,
read `docs/AGENTS.md` completely and follow its progressive-disclosure routing. This applies to
design answers in chat as well as file edits.

Do not answer from conversation memory when a current repository document exists. Reopen the
authoritative files for the topic and distinguish explicitly between:

- documented decisions;
- decisions discussed but not yet documented;
- unresolved questions.

Never fill an undocumented contract by inference. Name the gap and stop before building further
rules on top of it.

## Implementation required reading

Before changing code, read:

1. `docs/AGENTS.md` and the sources it routes for the topic;
2. the complete current specification and machine-readable contract governing the package being
   changed;
3. the accepted ADRs referenced by those sources;
4. the assigned file under `plans/`.

Do not infer architecture from an implementation stub. Specifications and machine-readable
contracts take precedence over code only when they are aligned with the accepted remodeling
baseline. ADRs explain decisions but do not replace specifications. If no aligned normative
specification exists, or if one conflicts with an accepted remodeling ADR, stop and repair the
documentation before implementation.

## Forbidden concept drift

Do not introduce:

- `Conversation` as a domain aggregate;
- a `Run` entity or `run_id`;
- `Loge` or `loge_id`;
- a persisted or reusable `SessionRuntime` domain object or `runtime_id`;
- `native_session_id`;
- a harness `Thread` as an Agora aggregate;
- an Agora `Agent` or `agent_id` as the selected integration; use `harness` and `harness_id` while
  reserving Agent for the ACP protocol role and OneCLI Agent for OneCLI;
- fixed combination profiles such as `repo-dev-vault`;
- a custom semantic protocol around ACP;
- application-owned infrastructure logs;
- parsed or normalized Save payloads.

For remodeled architecture, accepted terms and meanings are routed by `docs/AGENTS.md`. Some flat
specifications still describe the previous model; a conflict is a documentation defect, not
permission to blend both models.

## Protocol rules

- Import ACP v1 types from `@agentclientprotocol/sdk`.
- Preserve complete ACP envelopes, including unknown `_meta` fields.
- Never duplicate or fork ACP request/update types in local contracts.
- A network bridge may frame or authenticate ACP bytes; it must not translate ACP semantics.
- ACP v2 is draft and must not enter production code without a new ADR.

## Persistence rules

- Projection tables must be disposable and rebuildable.
- Core product code must treat Save bytes as opaque.
- Infrastructure telemetry never belongs in the product journal.
- Every externally retried command must have an idempotency key.

## Security rules

- Browser Intent may select reviewed named capabilities, never raw provider scopes or OneCLI
  identifiers.
- Only the trusted policy compiler resolves named capabilities into grants.
- Only the runtime controller owns Kubernetes workload permissions.
- Provider secrets live only in OneCLI; its control key and upstream OneCLI Agent bearer never
  enter a runtime Pod.
- OneCLI is the only credential gateway. Never build/port a parallel MITM, secret store, injector or
  provider adapter.
- Broker may implement only OneCLI control lifecycle and a workload-authenticated opaque relay; that
  relay must not terminate provider TLS, inspect provider content or inject credentials.
- Every Pod incarnation uses one dedicated selective OneCLI Agent; that Agent may serve only
  successive Sessions on that same Pod.
- Harness images contain pinned harness/ACP binaries; Pods never install them at startup.
- Never persist bearer tokens, one-time ACP tunnel tokens or provider credentials in product data,
  projection data, Saves or ACP data. The only exception is encrypted Broker-private upstream
  OneCLI authority required by ADR 0009; provider credentials remain OneCLI-owned.
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

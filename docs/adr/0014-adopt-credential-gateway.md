# ADR 0014 — Adopt a credential gateway before building one

- **Status:** Proposed
- **Date:** 2026-07-29

## Context

The former runtime contains custom gateway/MITM and credential-injection code. OneCLI publicly
documents gateway-backed execution for both Claude Code and Codex in which the wrapped Agent does
not receive stored raw credentials.

That capability concerns Agent/provider authentication. It is independent from the ACP adapter that
exposes Session, prompt, update and resume semantics.

## Decision

`Broker` remains Agora's logical policy/credential trust boundary and its contracts remain
implementation-neutral.

Before porting or writing credential gateway code, P08 MUST evaluate self-hosted
[OneCLI coding-agent support](https://onecli.sh/docs/guides/coding-agents) against Agora's actual
Claude Max and ChatGPT/Codex authentication, Session isolation, workload-identity, revocation,
auditing and no-secret-in-Loge requirements.

If it passes, Agora adopts/integrates it behind the Broker boundary. If it only partially passes,
Agora builds only the evidenced missing policy/isolation layer. A custom MITM implementation is
allowed only after the spike records a concrete failed gate.

OneCLI is not treated as an ACP adapter. ACP adapter selection remains in P09/P10.

## Alternatives rejected

- **Port the old gateway first:** spends implementation effort before proving an existing component
  cannot satisfy the contract.
- **Adopt OneCLI from its feature list alone:** does not prove subscription renewal, tenant
  isolation, revocation or custody exclusion in Loges.
- **Use OneCLI as Agora's product protocol:** conflates credential transport with ACP semantics.
- **Let each Agent own arbitrary credentials:** breaks the Broker trust boundary and makes
  revocation/secret custody harness-specific.

## Consequences

- P08 is blocked until this proposal is reviewed.
- The mandatory spike precedes any gateway port.
- P09/P10 validate the selected credential path end-to-end with their ACP adapter.
- Broker APIs and Workstream history do not depend on OneCLI-specific data models.

## Governing specs

- [Equipment and Broker](../specs/10-equipment-and-broker.md)
- [Security](../specs/11-security.md)

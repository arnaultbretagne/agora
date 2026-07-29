# ADR 0011 — Loges are untrusted; trust zones remain separate

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Agents execute model-generated code and may be prompt-injected. Hardening only the process cannot
make it trustworthy. Repository consolidation also creates a risk that product, Kubernetes and
provider-secret privileges accidentally merge.

## Decision

The Loge Pod remains the untrusted execution boundary. Product control plane, Loge controller,
Broker, Web and Loges use separate workload identities and least privilege.

Provider secrets never enter Loges. The Broker issues/uses downstream credentials behind scoped
execution grants bound to Session-specific workload identities; no grant secret is placed in an ACP
descriptor. Loges cannot access Kubernetes API, product Postgres, other Loges or custody storage
directly.

## Alternatives rejected

- **Trust Agent permission prompts:** prompt injection can influence them.
- **Put provider secrets in Loge env/files:** any in-Loge code can exfiltrate them.
- **One monorepo ServiceAccount:** collapses unrelated compromise domains.
- **Rely only on private code/repo rules:** does not protect infrastructure credentials and data.

## Consequences

- Multiple deployables and network/database policies are mandatory.
- Local development needs explicit safe substitutes for workload identity.
- End-to-end authorization tests require a real cluster/database role setup.
- Agent usefulness may allow broad Internet egress while secrets remain isolated.

## Governing specs

- [Security](../specs/11-security.md)

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
execution grants bound to Session-specific workload identities. OneCLI alone stores and injects
provider credentials. The Broker access relay holds the per-Session OneCLI upstream authority
outside the Agent container and only tunnels authenticated traffic to OneCLI; no grant secret is
placed in an ACP descriptor. Loges cannot access Kubernetes API, product Postgres, other Loges,
custody storage, OneCLI control API or the OneCLI gateway directly.

Loge egress is forced through the workload-authenticated relay. OneCLI policy contains explicit
allows followed by `block *`; its built-in Default Rule is not accepted as deny-by-default. Gateway
stdout MUST be query-free because signed URL parameters are credentials.

## Alternatives rejected

- **Trust Agent permission prompts:** prompt injection can influence them.
- **Put provider secrets in Loge env/files:** any in-Loge code can exfiltrate them.
- **One monorepo ServiceAccount:** collapses unrelated compromise domains.
- **Rely only on private code/repo rules:** does not protect infrastructure credentials and data.
- **Trust the OneCLI bearer inside the Agent process:** makes a Session-scoped credential
  exfiltratable and replayable outside the Loge.

## Consequences

- Multiple deployables and network/database policies are mandatory.
- Local development needs explicit safe substitutes for workload identity.
- End-to-end authorization tests require a real cluster/database role setup.
- Every Agent upgrade requires an explicit OneCLI route-set diff before egress is opened.

## Governing specs

- [Security](../specs/11-security.md)

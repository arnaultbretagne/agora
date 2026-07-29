# ADR 0011 — Session Runtimes are untrusted; trust zones remain separate

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Agents execute model-generated code and may be prompt-injected. Hardening only the process cannot
make it trustworthy. Repository consolidation also creates a risk that product, Kubernetes and
provider-secret privileges accidentally merge.

## Decision

The Pod materializing a Session Runtime remains the untrusted execution boundary. Product control
plane, Session Runtime controller, Broker, Web and Session Runtime workloads use separate identities
and least privilege.

Provider secrets never enter Session Runtime Pods. The Broker issues/uses downstream credentials
behind scoped execution grants bound to Session-specific workload identities. OneCLI alone stores
and injects provider credentials. The Broker access relay holds the per-Session OneCLI upstream
authority outside the Agent container and only tunnels authenticated traffic to OneCLI; no grant
secret is placed in an ACP descriptor. Session Runtime Pods cannot access Kubernetes API, product
Postgres, other Session Runtime Pods, custody storage, OneCLI control API or the OneCLI gateway
directly.

Session Runtime egress is forced through the workload-authenticated relay. OneCLI policy contains
explicit allows followed by `block *`; its built-in Default Rule is not accepted as deny-by-default.
Gateway stdout MUST be query-free because signed URL parameters are credentials.

## Alternatives rejected

- **Trust Agent permission prompts:** prompt injection can influence them.
- **Put provider secrets in Session Runtime env/files:** any code inside the runtime can exfiltrate
  them.
- **One monorepo ServiceAccount:** collapses unrelated compromise domains.
- **Rely only on private code/repo rules:** does not protect infrastructure credentials and data.
- **Trust the OneCLI bearer inside the Agent process:** makes a Session-scoped credential
  exfiltratable and replayable outside the Session Runtime.

## Consequences

- Multiple deployables and network/database policies are mandatory.
- Local development needs explicit safe substitutes for workload identity.
- End-to-end authorization tests require a real cluster/database role setup.
- Every Agent upgrade requires an explicit OneCLI route-set diff before egress is opened.

## Governing specs

- [Security](../specs/11-security.md)

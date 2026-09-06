# Security review

A walk through every trust boundary [execution.md — Owners and isolation](../specs/reconciliation/execution.md)
draws, against what is actually built. Each row says what the boundary claims, where that claim is
enforced, and how it was checked. Where the check is "read the code" rather than "a test fails if it
breaks", the row says so — a review that does not distinguish those is a review nobody can act on.

**Status: reviewed against the code and the test suite. NOT reviewed against a deployed cluster** —
the rows marked *deployment* need a running system with real OneCLI credentials, and that run is the
same open item S8, S9 and S10 each record.

## The Pod holds nothing

| Claim | Enforced at | Evidence |
|---|---|---|
| A harness Pod carries no Kubernetes token | `k8s-pod-spec.ts` sets `automountServiceAccountToken: false` | `pod-spec.test.ts` asserts it; a change fails the test |
| A harness Pod cannot reach the Save store | it holds no connection string; bytes arrive over the owner API, under a placement token bound to (Pod, Save) | `custody-transport.test.ts` — a wrong token is `unauthorized`, and the token is minted per placement |
| A harness Pod holds no provider credential | the relay holds the OneCLI bearer; the Pod's env carries a non-secret placeholder that only selects OAuth mode | code + field findings §2.2; **deployment** for the live assertion |
| A harness Pod's egress is the relay only | `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` in the PodSpec, plus the default-deny NetworkPolicy and the relay egress policy | `contracts/k8s/20-default-deny-networkpolicy.yaml`, `30-harness-relay-egress-networkpolicy.yaml`; **deployment** for the live assertion (the conformance suite's `isolation/allowed-and-denied-provider-calls` row is written and skips without a Pod) |
| A Pod's root filesystem is read-only | `securityContext.readOnlyRootFilesystem: true`; the one writable path is the harness-home `emptyDir`, owned by `fsGroup` | `pod-spec.test.ts` |
| A Pod runs as a numeric non-root UID | `runAsNonRoot`, `runAsUser: 10001` — a named account is not proof to the kubelet | `pod-spec.test.ts`, and both harness images assert `id -u` = 10001 in CI |

## The Broker holds the key, and only the Broker

| Claim | Enforced at | Evidence |
|---|---|---|
| The OneCLI control key is the Broker's alone | only `deploy/base/broker.yaml` mounts `agora-onecli/CONTROL_KEY` | manifest review; nothing else references that secret |
| Agent bearers never reach a Pod | the Broker stores them in its private store and the relay attaches them itself (ADR 0009) | `apps/broker/src/private-store.ts`, `relay/`; `broker` tests |
| The Broker has no Kubernetes authority | its ServiceAccount has no RBAC and does not mount a token | `deploy/base/broker.yaml` |

## The control plane cannot reach the owners' authority

| Claim | Enforced at | Evidence |
|---|---|---|
| The control plane has no Kubernetes credentials | its ServiceAccount mounts no token and has no RBAC | `deploy/base/control-plane.yaml` |
| The control plane has no OneCLI credentials | it holds no OneCLI secret; it asks the Broker | manifest review |
| The control plane never reads Save bytes | it holds no payload-role connection; `save_payloads` has no grant to `agora_product` | `contracts/db/schema.sql`; `packages/custody`'s role tests assert the product role cannot touch the bytes and the payload role cannot see the metadata |
| Publication is an operator action, not a user one | the endpoint requires the configured service actor and is closed entirely where none is configured | `admin-publish.test.ts` — a valid product principal gets 401, a wrong actor 403 |

## PostgreSQL roles

| Role | May | May not | Evidence |
|---|---|---|---|
| `agora_product` | append Intents and facts, open Sessions, record Saves, publish Anchors | touch `save_payloads`; update or delete a Save | schema grants; `packages/custody` role tests |
| `agora_engine` | manage the workset and owner attempts | write Intents, facts or Sessions | schema grants |
| `agora_custody_payload` | read and write Save bytes | see Save metadata or Anchors | `custody.test.ts` role boundary tests |
| `agora_custody_meta` | read Save metadata and Anchors | write anything | schema grants |
| `agora_retention` | delete Saves, payloads and invalidations | create a Save or publish/unpublish an Anchor | schema grants — retention cannot make its own deletion legal |
| `agora_projector` | read facts, write projections | write canonical history | schema grants |

## Authentication between components

| Claim | Enforced at | Evidence |
|---|---|---|
| The bridge accepts only a token minted for that exact incarnation | HMAC over the incarnation, verified in `verifyClient` before the WebSocket opens | `bridge-server.test.ts`; `owner-protocol.test.ts` asserts a token verifies for its own incarnation and fails for another |
| A placement or capture token is bound to its purpose | separate HMAC purpose strings; a placement token cannot fetch a capture | `custody-transport.test.ts` |
| The relay identifies a Pod by source IP, never a header | ADR 0009 / P10 | `apps/broker/src/relay/`; **deployment** for the live assertion |

## Logs and metrics

| Claim | Enforced at | Evidence |
|---|---|---|
| A log line carries only the correlation set | `packages/telemetry` is an ALLOW LIST, not a redaction pass | `telemetry.test.ts` feeds a prompt, a tool result, a bearer, a query string, Save bytes and a credential through every field name and asserts that neither the values nor their fragments appear |
| An error's message never reaches a log | `errorClass()` reports the class or code, never the message | `telemetry.test.ts` |
| Metric labels come from closed vocabularies | rule ids, verbs, attempt states, error classes | `telemetry.test.ts`; a label is a log field that is kept for longer |
| Save bytes never enter a log | the control plane never holds them; the transport logs byte counts | code review — this is the one claim here with no test that would fail if it broke, because there is no code path that could |

## What this review does not cover

- **The deployed system.** Every row marked *deployment* is a claim about manifests and code, checked
  by reading them. Confirming it on a cluster with real OneCLI credentials is the open item.
- **The OneCLI backup/restore drill.** Written in the runbook from the measured asset list; not
  performed.
- **Supply chain provenance.** CI builds both harness images and both are asserted to run as a
  non-root UID with their pinned adapters; SBOM and provenance attestation are wired in the workflow
  but the attestations have not been consumed by anything that verifies them.

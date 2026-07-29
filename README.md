# Agora

Agora is an ACP-native product for running durable human/agent workstreams in isolated
**Session Runtimes**.

This repository is a clean architectural baseline. It intentionally contains contracts,
specifications and implementation plans before production code. Agents implementing the system must
follow [AGENTS.md](AGENTS.md) and the plan dependency graph in [plans/README.md](plans/README.md).

## Five core terms

1. A **Workstream** is the non-null business object shown by the product.
2. A **Session** is one ACP execution context attached to one Workstream and one Agent.
3. A **Session Runtime** is the singleton infrastructure subresource through which exactly one
   Session is materialized, not another domain entity.
4. An **Anchor** records how much of a Workstream is durably known by one Agent.
5. A **Custody snapshot** is opaque harness state used to resume one Session.

There is no `Conversation`, `Run`, `Loge`, reusable Session Runtime, generic runtime profile or
custom Agent message protocol.

## Repository shape

```text
apps/
  web/               Human-facing web application
  control-plane/     Workstream API, Session coordinator and ACP Client
  session-runtime-controller/
                     Kubernetes lifecycle for Session Runtimes
  broker/            Capability policy, OneCLI lifecycle and opaque workload relay

packages/
  domain/            Domain types and invariants
  acp/               ACP connection and journaling integration
  store-pg/          Product journal and projections
  session-runtime-control/   Session Runtime control client/server contracts
  custody/           Opaque custody persistence
  equipment-policy/ Capability request and grant resolution
  agent-registry/    Trusted Agent runtime definitions
  observability/     Correlation helpers only

agents/
  claude-code/       Claude ACP runtime definition and custody driver
  codex/             Codex ACP runtime definition and custody driver

contracts/           Machine-readable HTTP, event, registry and SQL contracts
docs/specs/          Normative system specifications
docs/adr/            One consolidated ADR series and index
plans/               Ordered implementation plans for coding agents
```

The repository is a monorepo, not a monolith. `control-plane`, `session-runtime-controller`, and
`broker` are separate deployables with separate identities and permissions.

Self-hosted OneCLI is the separately operated, pinned credential gateway. It alone stores/injects
provider credentials and performs MITM; Agora does not contain a parallel gateway.

## Read order

1. [Glossary](docs/specs/00-glossary.md)
2. [System architecture](docs/specs/01-system-architecture.md)
3. [Domain model](docs/specs/02-domain-model.md)
4. [ADR index](docs/adr/index.md)
5. [Implementation program](plans/00-program.md)

## Contract checks

```bash
npm ci
npm test
```

The local checker validates repository indexes/links, JSON Schemas, OpenAPI documents and the agent
plan graph. CI additionally applies both SQL contracts to a disposable PostgreSQL 17 service.

## Status

Architecture baseline accepted on 2026-07-29 after the OneCLI spike. P01 is ready; every later
package remains gated by the dependency graph and its plan exit criteria.

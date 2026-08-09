# `@agora/broker`

Policy and OneCLI integration boundary. It resolves approved capability requests into short-lived
execution grants, provisions one OneCLI Agent per Session carrying only that Session's credential
grants, and authenticates Session Runtime workloads through an opaque access relay.

Two decisions, deliberately split ([ADR 0015](../../docs/adr/0015-onecli-credential-firewall-egress-at-relay.md)):

- **which credential may be injected** is OneCLI's, per Agent — `credential-policy.ts` compiles the
  reviewed set, `onecli-real.ts#syncCredentialGrants` attaches it, and OneCLI's own
  `effective-credentials` view is read back before the grant is trusted;
- **which host may be reached** is Agora's, per Session — `route-policy.ts` compiles a host
  allow-list and `relay.ts` enforces it deny-by-default on CONNECT, before any upstream socket
  exists. OneCLI OSS has no network rule to express this with.

OneCLI alone stores/injects provider credentials and terminates provider TLS. This package must not
grow a parallel credential gateway or provider-specific proxy; enforcing host egress at the relay is
not one — it decides only whether to open a tunnel.

Implementation is governed by `plans/08-equipment-and-broker.md` and
`plans/13-onecli-egress-relay-and-grants.md`.

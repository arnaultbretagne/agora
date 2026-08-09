# `@agora/broker`

Policy and OneCLI integration boundary. It resolves approved capability requests into short-lived
execution grants, provisions one selective OneCLI Agent per Session and authenticates Session
Runtime workloads through an opaque access relay.

OneCLI alone stores/injects provider credentials and terminates provider TLS. This package must not
grow a parallel credential gateway or provider-specific proxy.

Implementation is governed by `plans/08-equipment-and-broker.md`.

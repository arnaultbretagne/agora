# `@agora/control-plane`

Product API and ACP Client. Owns Workstreams, coordinates Sessions, appends ACP envelopes, evaluates
anchors and publishes the Web feed.

It has no Kubernetes workload permission and cannot read custody bytes or provider secrets.

Implementation is governed by `plans/03-acp-session-coordinator.md`.

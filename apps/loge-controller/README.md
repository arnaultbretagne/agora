# `@agora/loge-controller`

Trusted Kubernetes control plane for Loges. It materializes at most one Pod for a Session, injects
grants and custody, exposes an opaque ACP transport endpoint, captures custody, and dematerializes the
Pod.

It does not know Workstream history and never interprets ACP content.

Implementation is governed by `plans/04-loge-controller.md`.

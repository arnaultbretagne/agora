# `@agora/loge-controller`

Trusted Kubernetes control plane for Loges. It materializes at most one Pod for a Session, injects
credential-free runtime configuration, binds grants, restores/captures custody, exposes an opaque ACP
transport endpoint and dematerializes the Pod.

It does not know Workstream history, never interprets ACP content and never receives OneCLI/provider
credentials.

Implementation is governed by `plans/04-loge-controller.md`.

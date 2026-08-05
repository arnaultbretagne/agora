# OneCLI — live-cluster deployment for P09/P10 verification

A real, self-hosted OneCLI instance (`ghcr.io/onecli/onecli`, the same pinned digest
`ONECLI-SPIKE.md` tested), in its own namespace `agora-onecli-test`, PVC-backed (both Postgres data
and `/app/data`, unlike the disposable `emptyDir` P08's spike used — this deployment exists
specifically to also re-verify the CA-continuity-across-restart gap the spike found FAIL). Shared
across P09 (Claude, real Claude Max credential) and P10 (Codex, real ChatGPT credential deferred —
see plans/09/10's own Evidence for exactly when each was linked).

```
sudo k0s kubectl apply -f apps/broker/live-verification/
```

No credential ever lives in a committed file here. The Claude Max token is reused from the existing
SOPS secret `claude-oauth-token` (`/srv/infra-k8s/apps/agent/claude-oauth.secrets.yaml`, namespace
`agent`, already deployed) — decrypted with `sops` directly into a `kubectl create secret`/API call,
never echoed to a terminal or written to a file that isn't immediately shredded.

Teardown: `sudo k0s kubectl delete namespace agora-onecli-test` (also deletes both PVCs — the
underlying `local-path` host directories go with them).

# P04 live-cluster verification

Manifests used to verify plans/04-session-runtime-controller.md's exit criterion and required
tests against a real k0s cluster, in an isolated namespace (never the product's own namespaces).
Evidence/results are recorded in the plan file, not here.

```
sudo k0s kubectl apply -f apps/session-runtime-controller/live-verification/

# ghcr.io/arnaultbretagne/agora-fake-agent is currently a private package (GitHub does not expose
# a visibility API for personal, non-org packages) — pulls need an imagePullSecret:
sudo k0s kubectl create secret docker-registry ghcr-pull -n agora-p04-test \
  --docker-server=ghcr.io --docker-username=<gh-user> --docker-password="$(gh auth token)"

# a short-lived token for the RBAC-scoped ServiceAccount, to run the controller's own code
# against the live API from outside the cluster (K8sClient's host/port override):
sudo k0s kubectl create token session-runtime-controller -n agora-p04-test --duration=2h
```

Then instantiate `new K8sClient({ namespace: 'agora-p04-test', token, ca, host: 'localhost', port:
6443 })` (`ca` = `/var/lib/k0s/pki/ca.crt` on the node) and drive `materializeSessionRuntime`/
`reconcileSessionRuntime`/`dematerializeSessionRuntime` directly, same as the internal HTTP server
does. Pass `imagePullSecretName: 'ghcr-pull'` and `runtimeClassName: 'sandboxed'` in the
`MaterializeInput`.

Teardown: `sudo k0s kubectl delete namespace agora-p04-test`.

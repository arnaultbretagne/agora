# Session Runtime controller — live-cluster verification

Manifests used to verify this controller's plans (P04, then P06) against a real k0s cluster, in an
isolated namespace (never the product's own namespaces) — `agora-p04-test` despite the name, since
P06 reused the same namespace rather than duplicating the RBAC/PVC/ConfigMap setup. Evidence/results
are recorded in each plan file, not here. The namespace is torn down after each verification pass
(`sudo k0s kubectl delete namespace agora-p04-test`) and re-created from these manifests next time.

`10-network-policy.yaml`'s egress rule for `session-runtime-controller` Pods exists because P06's
restore-before-start flow has the Session Runtime Pod pull custody bytes from the controller's own
Service — found missing live (see plans/06-custody-and-resume.md Evidence), not designed in upfront.

`11`-`14` (Postgres + the controller itself, run as a real Pod with a real Service DNS name) are
P06-specific — P04's own verification drove the controller's functions directly from the node host
instead, since it had no reason to need the controller reachable FROM inside the cluster.

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

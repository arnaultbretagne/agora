# provisioning

The migration entry point provisions the schema and distinct restricted runtime logins from
environment configuration. It validates the resulting boundaries before reporting readiness.

`live-claude.ts` is an opt-in, billed measurement against a real Claude sandbox and the gateway.
Run it through `npm run measure:claude --workspace @agora/log`; the test runner provisions and
removes an isolated PostgreSQL database and three restricted runtime logins. Normal checks
never invoke the billed measurement.

| Environment | Value |
| --- | --- |
| `LOG_LIVE_KUBE_API` | Kubernetes API URL, with its CA trusted through `NODE_EXTRA_CA_CERTS`. |
| `LOG_LIVE_KUBE_TOKEN_FILE` | Runtime ServiceAccount token, with the executions package's reviewed Kubernetes permissions. |
| `LOG_LIVE_NAMESPACE` | Sandbox namespace; default `agora-sandboxes`. Use an isolated namespace when an older raw driver is deployed. |
| `LOG_LIVE_SIGNING_KEY_FILE` | Bridge authentication signing key corresponding to the sandboxes' public key. |
| `LOG_LIVE_GRANTS_KEY_FILE` | Grants signing key corresponding to the gateway's JWKS. |
| `LOG_LIVE_GATEWAY_PROXY` | CONNECT listener as reached from the sandbox, in host:port form. |
| `LOG_LIVE_KUBECTL_COMMAND` | JSON array for the tester's Kubernetes command; default is kubectl. Native-file capture requires tester access to Pod exec. |
| `LOG_LIVE_OUTPUT_DIR` | Private output directory for the report and ACP fixture. |

The gateway must have the Anthropic upstream credential, TLS CA, JWT verifier and reviewed
grant rule. Network policy permits only the measured sandbox to its CONNECT listener. The
runner mints a ten-minute JWT with only the Anthropic grant and hands the proxy/JWT to the
bridge's existing credentials transport. The upstream token stays at the gateway.

The cases use Haiku for a response, a bounded Bash command and recall after native restoration.
The tester captures quiescent native files with the bridge's own helper, publishes them through
the log, waits for infrastructure claim expiry and restores into a new Session. This measures
native capture/publication/restore, rather than the Pod termination hook or anchor receiver.
Both executions stop and expire before the database is removed. The report records one sample
per case, not a throughput benchmark. The ACP fixture contains only the controlled test history;
JWTs are explicitly checked to be absent. Review generated artifacts before committing them.

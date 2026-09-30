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

`measure-startup.ts` isolates initialization from journal work and model generation. Run it
through `npm run measure:startup --workspace @agora/log` with the same infrastructure settings;
the namespace, ready warm pool and tester's Kubernetes command must be supplied explicitly.
It does not use PostgreSQL or send a model prompt. Each run claims a fresh already-ready Pod,
measures initialize and two successive Session openings, closes both Sessions and expires its
claim. ACP phase durations and bridge outbound counters are included in the report.

| Environment | Startup experiment |
| --- | --- |
| `LOG_STARTUP_AUTH` | `before` by default; supplies the JWT before initialize. `after` deliberately withholds it until the first Session has closed, reproducing initialization with no gateway route. |
| `LOG_STARTUP_SDK_WARM` | `true` probes the bundled SDK's startup/reuse API instead of opening ACP Sessions. Requires credentials before initialization. It runs after claim and proves query-handle reuse; it does not implement warm-pool preinitialization. |

The phase readback requires an isolated harness template with `CLAUDE_AGENT_LOGS` set to
`/tmp/agora-acp-startup`. Only allow-listed phase fields are extracted, never the log's contents.
The SDK probe resolves the adapter's own CLI and SDK, inherits its loopback proxy environment
inside the Pod and keeps its prompt input empty. Nothing bypasses the gateway. Reports are
`startup-before.json`, `startup-after.json` and `startup-sdk-warm.json`. Each experiment needs a
fresh warm Pod; successive openings on one Pod are separate local-cache observations.

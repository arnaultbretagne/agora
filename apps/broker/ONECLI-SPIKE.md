# OneCLI credential-gateway spike

- **Status:** complete; adoption accepted, production blockers tracked
- **Date:** 2026-07-29
- **Scope:** OneCLI only

## Decision

Adopt OneCLI as Agora's provider-credential gateway and MITM implementation. Do not port the former
custom gateway and do not build a second credential-injection proxy beside OneCLI.

The tested release successfully ran the operator's real Claude Max and ChatGPT/Codex subscription
authentication while keeping both provider credentials out of the client container. It also
provided CA distribution, credential stubs, per-Agent credential selection, request policy and
immediate token rotation.

This is not yet an unconditional production approval. OneCLI needs a narrow Agora integration layer
for Session lifecycle and fail-closed provisioning, plus four production blockers must be resolved:

1. bind or confine the replayable OneCLI proxy bearer to one Loge workload;
2. remove query strings from gateway process logs;
3. publish an explicit catch-all block after the required allow rules and prevent direct egress;
4. persist and back up the CA state, database and externally supplied encryption key.

That integration layer provisions OneCLI and Loge configuration. Its selected workload-auth relay
may tunnel CONNECT bytes, but must not terminate provider TLS, inspect provider content or inject
credentials. The failed gates therefore do not justify restoring Agora's former MITM code.

ACP transport, ACP new/resume/update behavior and custody were deliberately not evaluated in this
spike, following the explicit scope decision. They remain separate tests.

## Versions tested

| Component | Version or immutable reference |
| --- | --- |
| OneCLI server | `1.43.3` |
| OneCLI image | `ghcr.io/onecli/onecli@sha256:7a4fef94337b3c7b16a044998eee342d3e6a6ab1b18c2c4b54e66d050337201b` |
| OneCLI server source inspected | `onecli/onecli@f91ebd4048fc` |
| OneCLI CLI | `2.8.1` |
| OneCLI CLI source inspected | `onecli/cli@4ffecaa9dbcf` |
| `@onecli-sh/sdk` | `3.0.0` |
| Claude Code | `2.1.209` |
| Codex CLI | `0.145.0` |
| Client base image | `node:22-bookworm` |
| PostgreSQL | `postgres:18-alpine` |

The server version was read from the deployed `/v1/health` endpoint. The image was pinned by digest,
not by a mutable tag.

## Test topology

```text
operator-side probe
  ├── OneCLI API :10254 ───────────────┐
  └── short-lived client pod           │
        ├── Claude Code                │
        ├── Codex CLI                  │
        ├── OneCLI CA + auth stubs     │
        └── HTTPS_PROXY ───────────────┼──> OneCLI gateway :10255 ──> providers
                                      │
                                      └──> PostgreSQL

OneCLI /app/data
  └── gateway CA and private key
```

The client pod received only:

- the OneCLI proxy URL and its `aoc_…` Agent bearer;
- the OneCLI CA and combined trust bundle;
- a Claude placeholder required to make Claude Code select OAuth mode;
- a read-only Codex auth stub containing only the marker `onecli-managed`.

The steady-state client configuration contained neither the OneCLI organization key nor the real
Anthropic/OpenAI credentials. The spike used disposable Kubernetes resources and ephemeral volumes;
this was intentional and is not the proposed production persistence topology.

## Harness packaging result

OneCLI does **not** install Claude Code or Codex and does not provide a Loge image. `onecli run`
wraps a command that must already exist, while the SDK only supplies proxy, CA and credential-stub
configuration.

For the spike, an init container installed pinned harness versions into a fresh client pod. A
production Agent image must instead bake and pin its harness, and CI must verify at least:

```text
command -v claude && claude --version
command -v codex && codex --version
```

OneCLI can replace the gateway implementation; it cannot replace Agora's Agent-image build and
attestation pipeline.

## Results

| Gate | Result | Redacted evidence |
| --- | --- | --- |
| Self-hosted deployment | **PASS** | API healthy; gateway accepted authenticated CONNECT; image pinned by digest |
| Real Claude Max authentication | **PASS** | `onecli run -- claude …` returned exactly `ONECLI_RUN_CLAUDE_OK` |
| Real ChatGPT/Codex authentication | **PASS** | `onecli run -- codex exec …` returned exactly `ONECLI_RUN_CODEX_OK` |
| Direct container configuration | **PASS** | Claude and Codex also succeeded from SDK-derived proxy/CA/stub configuration |
| TLS interception and CA trust | **PASS** | controlled HTTPS request validated against the generated OneCLI CA |
| Credential injection | **PASS** | a generated credential absent from the client request appeared at the controlled upstream |
| Provider credentials absent from Loge | **PASS** | process environment, Codex stub and 255 client files scanned; zero provider-credential matches |
| Provider credentials absent from logs | **PASS** | exact credential scans across gateway logs returned zero matches |
| Provider credentials encrypted in PostgreSQL | **PASS** | stored values were ciphertext and did not begin with their plaintext inputs |
| Per-Agent credential selection | **PASS** | default Agent received the controlled credential; a selective Agent with no grant did not |
| Workload identity binding | **FAIL** | the `aoc_…` proxy URL is a replayable bearer usable from an unrelated workload |
| Immediate manual revocation | **PASS** | old bearer: HTTP 204; one second after rotation: CONNECT rejected as invalid |
| Expiry and renewal | **FAIL** | Agent access tokens have rotation but no expiry/TTL or equivalent renewal contract |
| Explicit network block | **PASS** | an explicit host block returned HTTP 403 before upstream forwarding |
| Network allow-list | **PASS WITH INVARIANT** | ordered `allow httpbingo.org`, then `block *`: allowed host 200, unlisted host 403 |
| Built-in default block as egress deny | **FAIL** | uncredentialed, non-LLM request still returned 200; this is intentional OneCLI behavior |
| PostgreSQL request telemetry | **PASS** | 34 sampled rows contained no query strings or signed query values |
| Gateway process logs | **FAIL** | stdout logged full URLs, including one observed signed Codex download query |
| OneCLI API outage through `applyContainerConfig` | **FAIL-OPEN BY DEFAULT** | SDK returned `false` and left launch arguments unchanged |
| OneCLI restart with external encryption key | **PARTIAL PASS** | stored controlled credential decrypted and injected after pod replacement |
| CA continuity without persistent `/app/data` | **FAIL** | CA SHA-256 changed after pod replacement |
| Subscription renewal over time | **NOT PROVEN** | both current OAuth states worked; an actual expiry/refresh cycle was not observed |
| Backup/restore | **NOT PROVEN** | required state was identified, but a restore drill was outside this disposable spike |

No token, provider credential, signed URL or unredacted organization/project/Agent identifier is
included in this report.

## Reproduced harness executions

The following command shapes were run with a locally configured OneCLI CLI. Prompt text contained
only a fixed canary and is omitted here:

```bash
onecli run -- claude --print '<canary prompt>'
onecli run -- codex exec --skip-git-repo-check '<canary prompt>'
```

The gateway correlated the successful calls as:

- Anthropic `POST /v1/messages?beta=true`, HTTP 200, one injection;
- Codex WebSocket `/backend-api/codex/responses`, two injections.

These results prove the subscription authentication path through OneCLI. They do not prove ACP
behavior.

## Security findings

### OneCLI Agent isolation is useful but is not workload identity

OneCLI's selective Agent mode correctly limits which stored credentials are injected. The clean
mapping for Agora is:

```text
one Agora Session = one Loge = one dedicated OneCLI Agent
```

The OneCLI Agent must never be reused by another Session, and the default Agent's `all` mode must
never be used for a Loge.

However, the Agent access token is a bearer embedded in the proxy URL. Source inspection found no
expiry field, and the token is stored as an Agent access token rather than bound to Kubernetes
identity or mTLS. Anyone who obtains Session B's proxy URL can exercise Session B's OneCLI
authority. Rotation revokes it immediately, but does not prevent replay before rotation.

The accepted architecture chooses to confine that bearer outside the Agent process and authenticate
the Loge to a narrow, non-MITM forwarding seam using workload identity. It rejects placing the
per-Session bearer in the Loge or weakening the Broker contract.

Under the current security contract, this remains a production blocker. Any forwarding seam must
only authenticate and relay to OneCLI; it must not become a second credential gateway.

### Network policy needs explicit terminal blocking

OneCLI's project Default Rule is not a general egress firewall. Its default `block` action is
enforced only for credentialed, non-LLM traffic; uncredentialed traffic and recognized LLM hosts
bypass that terminal rule by design.

A real OneCLI allow-list was nevertheless proven with first-match rules:

1. explicit `allow` rules for required hosts/routes;
2. an explicit `block` rule targeting `*` as the final rule;
3. the terminal Default Rule left neutral.

The final catch-all is a required configuration invariant, not an optional UI convention. Kubernetes
network policy must additionally prevent the Loge from reaching the Internet directly and force
provider egress through the Broker-relay-to-OneCLI path. The CLI's `--enforce` option is
Claude-specific and is not a substitute for Kubernetes enforcement across both harnesses.

### Gateway stdout leaks query-string secrets

Persistent `request_logs` telemetry strips the query string and stores only method, host, sanitized
path, status, latency, injection count and identifiers.

The gateway process logger does not use that sanitized path. It logs a URL constructed from
`path_and_query`. During the Codex test, this emitted a signed download URL including its signature.
Provider OAuth values did not appear, but a signed query parameter is still a bearer leak.

Production adoption is blocked until OneCLI logs only scheme, host and query-free path. Prefer an
upstream fix; otherwise carry the smallest source patch and a regression test. Filtering at the log
collector is defense in depth, not the primary fix, because the secret has already been written to
stdout.

The manual-approval feature also creates an in-memory request-body summary for approval cards. Agora
must not enable manual approval on LLM/tool routes whose content is subject to the no-content
telemetry rule.

### OpenAI injection surface is broad

The tested OpenAI credential is eligible for injection on `api.openai.com`, `chatgpt.com`,
`*.chatgpt.com` and `*.openai.com`. The live Codex run therefore caused injection decisions on
several ChatGPT subdomains, including an analytics host.

Selective Agents limit which credential is available, but not this provider-defined host expansion.
The explicit OneCLI allow-list must narrow the usable host set to the endpoints required by the
pinned Codex version, and upgrades need a route-diff test.

## Container integration findings

`@onecli-sh/sdk` exposes two materially different paths:

- `getContainerConfig` returns the proxy environment, CA and stub material;
- `applyContainerConfig` mutates Docker CLI arguments and writes host-side temporary files.

Agora should use `getContainerConfig` from the Broker control adapter. The adapter extracts the
upstream proxy bearer into Broker-private state for the workload relay and verifies the returned
CA/stub inputs against the controller's operator-managed, credential-free runtime bundle. It must
reject the launch if OneCLI is unavailable, returns incomplete data or disagrees with that bundle.

`applyContainerConfig` is unsuitable for the production controller because:

- it deliberately returns `false` without changing Docker arguments on network/5xx failure;
- its generated host files use deterministic global paths under `/tmp`, which can race across
  concurrent Session launches;
- it is designed around Docker arguments rather than Kubernetes objects.

Likewise, `onecli run` is useful for local verification, not as the production launch contract. Its
child process inherits the caller environment, so a control key supplied through
`ONECLI_API_KEY` can be inherited by the wrapped harness. The OneCLI organization/project control
key must remain in the trusted Broker control adapter and must never enter a Loge.

OneCLI publishes no Kubernetes or Helm deployment in the inspected source release. Agora therefore
owns the Kubernetes packaging, readiness, disruption, network-policy and backup configuration for
the adopted component.

## Persistence and restart

Production state spans three separate assets:

1. PostgreSQL, including encrypted provider credentials, Agent configuration, policy and audit;
2. `/app/data`, containing the gateway CA and private key;
3. the externally managed `SECRET_ENCRYPTION_KEY`.

The restart probe stored a generated credential, replaced the OneCLI pod, fetched fresh container
configuration and successfully used the recovered credential. This proves that PostgreSQL plus the
same external encryption key can restore credential use.

Because the spike mounted `/app/data` as `emptyDir`, the CA changed during that same replacement.
Existing Loges holding the former CA would then fail TLS validation. Production must persist
`/app/data` or implement an atomic CA-rotation/rematerialization procedure. A backup/restore drill
covering all three assets remains mandatory before rollout.

## Required production integration

The minimal Agora-owned integration is:

1. create one uniquely named OneCLI Agent for the Session;
2. set it to selective mode and publish only the Session's approved credential/policy rules;
3. call `getContainerConfig` from the trusted Broker control adapter;
4. keep upstream proxy authority in Broker-private state and bind it to the workload relay;
5. materialize only credential-free relay endpoint, CA and non-secret stubs in the Loge;
6. fail the Loge launch if any OneCLI/relay step fails;
7. enforce ordered allow rules followed by explicit `block *`;
8. deny direct Loge egress outside the relay path;
9. rotate/delete the OneCLI Agent authority when the Session ends or is revoked;
10. delete the OneCLI Agent rather than reusing it for a later Session.

The integration must also reconcile partial failures idempotently: an Agent without a Loge, a Loge
without complete container configuration, and a terminated Loge whose Agent token is still valid.

## Remaining acceptance work

Before production rollout:

- fix and regression-test query-free gateway stdout;
- implement and prove the selected workload-authenticated opaque relay;
- automate the explicit terminal block invariant and test rule ordering;
- bake pinned Claude/Codex tools into their Agent images;
- run a real provider token expiry/refresh cycle for both subscriptions;
- perform PostgreSQL + `/app/data` + encryption-key backup and restore;
- test high availability and cache invalidation during policy publication;
- run the separate ACP and custody tests that were explicitly out of scope here.

## Final recommendation

**Adopt OneCLI for MITM and provider credential injection; wrap its control plane; build no competing
gateway.**

The evidence supports deleting the former custom MITM from the greenfield design. The remaining work
is Session/workload lifecycle, deployment hardening and two focused OneCLI security fixes—not a
second implementation of TLS interception or Claude/Codex credential injection.

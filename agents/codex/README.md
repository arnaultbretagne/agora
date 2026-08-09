# Codex Agent definition

Trusted runtime definition and opaque custody driver for the selected Codex ACP adapter
(`@agentclientprotocol/codex-acp`, `SPIKE.md`'s recommendation — no local ACP adapter).

`src/bridge-server.ts` is the container entrypoint `packages/agent-registry`'s `codex` runtime
definition names: spawns the real ACP adapter per WebSocket connection (restore-before-ready),
then bridges the Session Runtime controller's WebSocket connection directly to its stdio.
`src/custody.ts` captures/restores the ONE native rollout file that matters for `session/resume`
continuity (`SPIKE.md`'s own finding — never the rest of `$HOME/.codex`, which is global,
non-Session state: `*.sqlite` state/memories/goals/logs, `cache/`, `skills/`). Unlike Claude Code,
this file's path is date-partitioned, not deterministic from `sessionId` alone, and — verified
live — must be restored at its *exact* original relative path or `session/resume` fails; the
custody driver's own wire format is a small `{relativePath, contentBase64}` envelope to carry that.

ChatGPT authentication uses the fixed Broker-relay/OneCLI path exclusively (`apps/broker`), proven
live in `SPIKE.md`. Unlike Claude Code's env-var placeholder, `codex-acp` reads its credential from
a file (`$HOME/.codex/auth.json`) and validates it as a real JWT locally — `bridge-server.ts`'s
`ensureCodexAuthStub` constructs a fixed, non-secret, never-functional placeholder there
deterministically before every spawn.

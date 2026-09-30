# fixtures

`claude-code.json` contains the canonical history captured by `scripts/live-claude.ts` on
2026-09-30: a real Haiku response and a bounded Bash call through the gateway, using the pinned
Claude Code 2.1.261 and claude-agent-acp 0.75.1 image. Prompts and tool content are synthetic test
data. It contains no gateway JWT, upstream credential or native anchor bytes.

The ordinary PostgreSQL test replays each source occurrence, projects incrementally and then
rebuilds, comparing identities and the hash with the captured live projection. The separate
`claude-code-report.json` records the original execution and native restoration results. Timing samples
describe that run only.

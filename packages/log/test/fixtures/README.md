# fixtures

`claude-code.json` contains the canonical history captured by `scripts/live-claude.ts` on
2026-09-30: a real Haiku response and a bounded Bash call through the gateway, using the pinned
Claude Code 2.1.261 and claude-agent-acp 0.75.1 image. Prompts and tool content are synthetic test
data. The image installs global Claude Code 2.1.261; the adapter runs its bundled Agent SDK
0.3.257 CLI, verified as Claude Code 2.1.257. The fixture contains no gateway JWT, upstream
credential or native anchor bytes.

The ordinary PostgreSQL test replays each source occurrence, projects incrementally and then
rebuilds, comparing identities and the hash with the captured live projection. The separate
`claude-code-report.json` records the original execution and native restoration results. Timing samples
describe that run only.

`claude-code-startup-report.json` preserves the direct startup A/B and SDK preinitialization
probe on fresh warm Pods using that same image. Neither experiment sends a model prompt or
uses the journal. It also records a separate complete log/Claude run with the gateway JWT
supplied before opening, and its monotonic driver stage measurements. The original ACP fixture
and report remain the original capture; these measurements do not replace its replay hash.
`claude-code-platform-timings.json` holds the complete log run's 2,062 raw allow-listed stage
observations, with the same summaries as the startup report. No model or tool content appears
in these observations.

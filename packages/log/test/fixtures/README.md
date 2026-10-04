# fixtures

`claude-code.json` is a canonical history captured on 2026-09-30 during a live run on g4: a real
Haiku response and a bounded Bash call through the gateway, with Claude Code 2.1.261 and
claude-agent-acp 0.75.1. Prompts and tool content are synthetic. It holds no JWT, upstream
credential or anchor bytes. `projectionHash` is the hash of the core projection of that history, at
the projector's version in force (4: the Workstream view's title, state, pool, harness, anchor,
settings, commands, `configuring` and `profiles`, and the Session notices); the log tests replay the
history incrementally and through a rebuild, and compare with it. A new projector version records
it again; the history itself never changes.

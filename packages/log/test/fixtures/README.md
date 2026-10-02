# fixtures

`claude-code.json` is a canonical history captured on 2026-09-30 during a live run on g4: a real
Haiku response and a bounded Bash call through the gateway, with Claude Code 2.1.261 and
claude-agent-acp 0.75.1. Prompts and tool content are synthetic. It holds no JWT, upstream
credential or anchor bytes. `projectionHash` is the hash of the projection computed during that
run; the log tests replay the history incrementally and through a rebuild, and compare with it.

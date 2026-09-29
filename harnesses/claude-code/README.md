# claude-code

Image `agora-harness-claude-code`: the bridge in front of `claude-agent-acp`. Pinned versions,
the ones measured by S8/S9. No credential in the image: `CLAUDE_CODE_OAUTH_TOKEN` is only a
marker that puts the CLI in OAuth mode; the gateway sets the real token on the way, once the
execution's grants are attached (`docs/specs/credentials.md`). Native directory saved:
`$HOME/.claude/projects/<workspace slug>/`.

`docker build -f harnesses/claude-code/Dockerfile .` from the root.

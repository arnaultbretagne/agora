# claude-code

Image `agora-harness-claude-code` : le bridge devant `claude-agent-acp`. Versions épinglées,
celles mesurées par S8/S9. Aucun credential : les prompts échouent en 401 tant que les
credentials des harnesses (Agent Vault) ne sont pas branchés. Dossier natif sauvegardé :
`$HOME/.claude/projects/<slug du workspace>/`.

`docker build -f harnesses/claude-code/Dockerfile .` depuis la racine.

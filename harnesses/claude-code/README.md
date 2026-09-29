# claude-code

Image `agora-harness-claude-code` : le bridge devant `claude-agent-acp`. Versions épinglées,
celles mesurées par S8/S9. Aucun credential dans l'image : `CLAUDE_CODE_OAUTH_TOKEN` n'est qu'un
marqueur qui met la CLI en mode OAuth ; la passerelle pose le vrai token au passage, une fois
les droits de l'exécution branchés ([docs/credentials.md](../../docs/credentials.md)). Dossier
natif sauvegardé : `$HOME/.claude/projects/<slug du workspace>/`.

`docker build -f harnesses/claude-code/Dockerfile .` depuis la racine.

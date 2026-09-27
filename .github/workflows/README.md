# workflows

`sandbox-backend.yml` : à chaque push de `feat/sandbox-backend`, typecheck et tests de chaque
workspace, puis construction, essai et publication par digest des trois images
(`agora-sandbox-backend`, `agora-sandbox-mock`, `agora-sandbox-claude-code`). Le digest est dans
le résumé du run.

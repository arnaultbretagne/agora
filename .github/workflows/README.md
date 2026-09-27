# workflows

`executions.yml` : à chaque push de `feat/executions`, typecheck et tests de chaque workspace,
puis construction, essai et publication par digest des trois images (`agora-lab`,
`agora-harness-mock`, `agora-harness-claude-code`). Le digest est dans
le résumé du run.

# workflows

`ci.yml` : à chaque push sur la base ou une branche `feat/`, `fix/`, `chore/`, et à chaque PR
vers la base, typecheck et tests de chaque workspace. Sur un push, construction, essai et
publication par digest des trois images (`agora-lab`, `agora-harness-mock`,
`agora-harness-claude-code`), étiquetées par le commit. Le digest est dans
le résumé du run.

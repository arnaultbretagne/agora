# workflows

`ci.yml`: on every push to the base or to a `feat/`, `fix/` or `chore/` branch, and on every PR
to the base, typecheck and tests of every workspace. On a push, it builds and tries the images
(`agora-server`, and one per harness), the server's also as a preview; on the base, or run by hand,
it publishes them by digest, tagged with the commit. The digest is in the run's summary.

`preview.yml`: for a PR labelled `preview` whose branch is in this repository, when the label is set
and at each push while it stays, builds the server's image of the PR's head, tries it as a preview,
and publishes it as `agora-server:<full commit SHA>`. A PR without the label, or from a fork,
publishes nothing.

Both hold no permission by default (`permissions: {}`): each job declares the least it needs —
`check` reads only, the image jobs alone write packages and sign provenance. No value a branch's
author or an event chooses (a ref's name, a payload's field, an input) is written as `${{ … }}`
into a `run:` script: it reaches the script through `env:`, so the shell reads it as data, never
as code.

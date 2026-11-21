# workflows

`ci.yml`: on every push to the base or to a `feat/`, `fix/` or `chore/` branch, and on every PR
to the base, typecheck and tests of every workspace. On a push, it builds and tries the images
(`agora-server`, and one per harness), the server's also as a preview; on the base, or run by hand,
it publishes them by digest, tagged with the commit. The digest is in the run's summary.
The images are listed by `scripts/inputs.ts` (its `images()`, which `propose-infra.ts` reads too):
the server's, and one per folder of `harnesses/` holding a Dockerfile. A harness is added as a folder,
never in `ci.yml`.

`preview.yml`: for a PR labelled `preview` whose branch is in this repository, when the label is set
and at each push while it stays, builds the server's image of the PR's head, tries it as a preview,
and publishes it as `agora-server:<full commit SHA>`. A PR without the label, or from a fork,
publishes nothing.

No step that runs a pushed branch's or a PR's code holds write on the registry (ghcr.io, where
the cluster takes its images from): on their runs, only fixed steps do — those written in this
folder, which an agent's App cannot change. On a branch's push, `try` runs `image`'s steps with a
token that only reads packages, so the branch's code cannot leave an image under a tag the base
would reuse. `image`, which writes packages and signs provenance, runs on the base (code the
operator merged) and on a run by hand (code the operator chose) only. In `preview.yml`, `build`
builds and tries the PR's head with no registry login; `publish` checks out and runs nothing of
the PR, checks that the image handed over is the one built, and pushes that one tag by name. No
step here uses an action of this repository's (`uses: ./…`): it would run code from outside this
folder.

Both hold no permission by default (`permissions: {}`): each job declares the least it needs. A
checkout keeps no token (`persist-credentials: false`) unless a later step of its job pushes with
it. No value a branch's author or an event chooses (a ref's name, a payload's field, an input) is
written as `${{ … }}` into a `run:` script: it reaches the script through `env:`, so the shell
reads it as data, never as code.

# ADR 000n — Preview

- **Status:** proposed
- **Date:** 2026-11-16

## Context

- A change to the client is judged on a running Agora, not only on its tests. infra-k8s previews a pull
  request on `pr-<n>-<app>.preview.bretagne.dev` when it carries a label, behind the SSO, and removes it
  when the pull request closes (its ADR 0017, v4).
- That ADR deferred Agora (its §3): production's server holds four secrets — the bridges' signing key, the
  grants' key, the log's logins, the registry's pull secret — and creates real executions in
  `agora-sandboxes`.
- A preview namespace runs pull-request code under Kata. It may hold no Secret but its database's, reaches
  no API server, and reaches the Internet only if its catalogue entry says so. Its workload's manifests come
  from infra-k8s's `main`; only the image's tag comes from the pull request (`source: main`).
- Two gates stand in front of it: the admins' browsers, and Agora's gateway for test agents.

## Decision

1. **The same image, another mode.** `PREVIEW=true` and a database's URL are all a preview is given; a
   preview given anything only production sets does not start.
2. **Only the mock agent.** The preview's one pool runs `packages/mock-agent` inside the server's container,
   each sandbox a real bridge on the loopback; no real execution, no credential.
3. **Invented data, never production's.** At its first start on an empty database (`data: empty`), the
   server writes the client's fixtures as conversations: the mock agent's history at each of its marks, the
   three real harnesses' histories.
4. **The log on its owner's one login.** The preview's database gives one login, its owner, which may create
   no role: the server applies the schema without its runtime roles and runs on that login.
5. **One shared owner.** Whoever a gate names sees and writes the same conversations.
6. **An image per commit, for previews only.** CI publishes `agora-server:<full SHA>` for each commit of a
   pull request labelled `preview` from this repository; a branch's push publishes no image any more.

## Why

- The preview runs the pull request's own server and client, so what is previewed is what will ship;
  only what lies behind the server — Kubernetes, Agent Sandbox, the gateway, R2 — is stood in for.
- The mock agent is what the browser tests already drive: a preview shows every state they show, at no cost
  and with no way out.
- The fixtures are recorded histories: the states the client renders, and three real harnesses' tool-heavy
  runs, with nothing of a person's.
- A shared owner lets a judge working through the gateway and the person in a browser look at the same
  conversation.

## What we tried

| Option | Found | Dropped because |
| --- | --- | --- |
| The production schema with its runtime logins | CloudNativePG's `initdb` owner has no `CREATEROLE` (infra-k8s's `agora-pg` gives its owner `createrole` through managed roles, which a preview's template does not) | The preview's database could not apply it. |
| A copy of production's database (`data: restore`) | Possible with infra-k8s's previews | Decided against by the person: a preview's data are invented. |
| Each gate's identity owning its own conversations | The fixtures would be written for no one known in advance: the browser gate's email is the admin's | The fixtures could not be listed, and the two gates could not share a conversation. |
| An image for every push of every branch | What `ci.yml` did | Decided against by the person: images for previews only. |

## Consequences

- A preview's files and anchors live in the server's memory: each push, which starts a new Pod, loses them,
  its database kept.
- The fixtures ship in the server's image.
- A preview's sandboxes share the server's container and its memory limit: `MAX_ACTIVE` bounds them.

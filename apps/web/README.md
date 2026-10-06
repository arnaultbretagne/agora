# web

The client (`docs/specs/assistant-ui.md`): assistant-ui 0.15.23 on the log's thread, built with
Vite and served by the server at `/`.

| Folder | Content |
| --- | --- |
| `src/agora/` | Agora's side. Pure, run by Node's tests as is: `objects.ts` (the thread's rows, cursor, snapshot, reset), `view.ts` (objects → messages, the composer's state, sending, the notices, the list's sections), `tools.ts` (a tool line's label and change), `stream.ts` (the thread read with fetch, opened again from its cursor), `api.ts` (the routes and commands). React: `hooks.ts`, `runtime.tsx` (`useExternalStoreRuntime`, the first message's wait). |
| `src/screen/` | The screen, in assistant-ui's base skin: `shell.tsx` (frame, list, bar, theme), `thread.tsx`, `messages.tsx`, `tool.tsx` (tool lines, the permission card), `trace.tsx` (the trace grammar), `composer.tsx` (the harness picker), `brand.tsx` (the first Agora's mark), `harness-mark.tsx` (the harnesses' marks, for a narrow composer), `viewport.ts` (on a phone, the screen on the visual viewport). |
| `public/` | Served as they are: the favicon, and for a phone's home screen the manifest and its icons, rendered from the favicon's mark. |
| `src/components/` | The registry's components still used, copied (`components.json`): `MarkdownText`, `DiffViewer`, the `surfaces` helpers. |
| `test/` | `view.test.ts` and `stream.test.ts`: U1–U15; `browser/screen.test.ts`: U16–U24 and U27–U38, the built client in Playwright's Chromium against the real server (FakeKube, real bridges, the mock agent), run by `npm run test:browser` from the log package, which provisions PostgreSQL. `fixtures/mock.json`: a history through every state; `fixtures/claude-code.json`, `codex.json`, `opencode.json`: the real harnesses on a tool-heavy task. |
| `scripts/` | `capture.fixture.ts` captures the mock history, from `packages/log` (`node test/run.ts ../../apps/web/scripts/capture.fixture.ts`), which provisions PostgreSQL; `capture.real.ts` captures a real harness's, on a deployed server with `TEST_ROUTES` (`node apps/web/scripts/capture.real.ts <server> <pool> <harness>`); `screenshot.fixture.ts` renders the built client against a real server and saves screenshots, `screenshot.phone.ts` likewise on a phone's screen, light and dark, `POOLS=<file>` offering another catalogue in the draft (a manual check, not evidence). |

```sh
npm run build -w @agora/web                                  # into dist/, which the server serves
AGORA_SERVER=http://<server>:8080 npm run dev -w @agora/web  # Vite, its /api proxied to a server
npm test -w @agora/web
npm run test:browser -w @agora/web                           # builds, then U16–U38's browser cases
```

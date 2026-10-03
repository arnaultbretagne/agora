# web

The client (`docs/specs/assistant-ui.md`): assistant-ui 0.15.23 on the log's thread, built with
Vite and served by the server at `/`.

| Folder | Content |
| --- | --- |
| `src/agora/` | Agora's side. Pure, run by Node's tests as is: `objects.ts` (the thread's rows, cursor, snapshot, reset), `view.ts` (objects → messages, the composer's state, the notices), `stream.ts` (the thread read with fetch, opened again from its cursor), `api.ts` (the routes and commands). React: `hooks.ts`, `runtime.tsx` (`useExternalStoreRuntime`), `components.tsx` (the components Agora writes). |
| `src/components/` | The registry's components, copied (`components.json`) and modified where marked `Agora:`. |
| `test/` | `view.test.ts` and `stream.test.ts`: U1–U11. `fixtures/mock.json`: a real history the conversion folds. |
| `scripts/` | `capture.fixture.ts` captures that history; `screenshot.fixture.ts` renders the built client against a real server and saves screenshots (a manual check, not evidence). Both run from `packages/log` (`node test/run.ts ../../apps/web/scripts/<file>`), which provisions PostgreSQL. |

```sh
npm run build -w @agora/web                                  # into dist/, which the server serves
AGORA_SERVER=http://<server>:8080 npm run dev -w @agora/web  # Vite, its /api proxied to a server
npm test -w @agora/web
```

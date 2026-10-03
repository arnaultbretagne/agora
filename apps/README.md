# apps

What gets deployed or built. Each folder with a Dockerfile produces its own image.

| Folder | Image | Role |
| --- | --- | --- |
| `server/` | `agora-server` | The server: mounts the executions and the log, serves the client and the API; with `TEST_ROUTES`, the test page. |
| `web/` | — (in `agora-server`) | The client: assistant-ui on the log's thread. |

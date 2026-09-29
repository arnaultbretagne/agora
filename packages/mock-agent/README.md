# mock-agent

The lab's ACP agent: no model, a behaviour chosen by the prompt text, and a real native file
under `$HOME/.mock-agent/sessions/`, read back at `session/resume` and `session/load`.

| Prompt | Behaviour |
| --- | --- |
| free text | Numbered echo, with the previous message. |
| `/sleep N` | One chunk per second for N seconds. |
| `/silence N` | Nothing for N seconds, then an answer. |
| `/permission` | Asks for a permission and waits for the answer. |
| `/tool` | A tool call with a diff. |
| `/big N` | N KiB of text. |
| `/recall` | Recalls everything said in the session. |
| `/crash` | Exits with code 3. |
| `/fetch [METHOD] URL [BODY]` | A request through `HTTPS_PROXY`, like a real harness (`docs/credentials.md`); answers with what came back. GET by default. |

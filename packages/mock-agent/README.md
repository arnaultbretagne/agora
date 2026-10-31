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
| `/usage USED/SIZE` | Reports its context, a `usage_update` with these tokens in use and this size, a cost beside them. |
| `/fail` | Answers the prompt with an internal error (-32603) and keeps running, as an adapter whose agent process died. |
| `/crash` | Exits with code 3. |
| `/raw BASE64` | Writes the decoded lines byte for byte, invalid UTF-8 included, then answers: what the log must keep or refuse (`docs/specs/log.md`). |
| `/invalid-then-valid` | Answers the prompt with an invalid body, then with a valid one a second later. |
| `/answer-twice` | Answers the prompt twice. |
| `/fetch [METHOD] URL [BODY]` | A request through `HTTPS_PROXY`, like a real harness (`docs/specs/credentials.md`); answers with what came back. GET by default. |

It accepts images and embedded resources in a prompt, not audio. Before its behaviour, it says what
it received of them: an image's type, its width × height for a PNG or a JPEG, and its bytes; a
resource's `uri`, type and characters.

For tests, `AGORA_MOCK_INITIALIZE_DELAY_MS` delays the answer to `initialize`, and
`AGORA_MOCK_INITIALIZE_INVALID=1` makes it invalid.

# credentials

An execution's credentials, on Agora's side (`docs/credentials.md`): compile its profiles into
grants and sign them into a short JWT for the gateway. Agora never sees a credential. Handing
the token to the bridge is the executions' job (`POST /api/executions/{name}/credentials`).

| Folder | Content |
| --- | --- |
| `src/` | The profile catalogue and the grant signer. |
| `test/` | Profile compilation, composition, and the JWT. |

# src

| File | Role |
| --- | --- |
| `grants.ts` | The profile catalogue, their compilation into grants, and `GrantSigner`, which signs them into an EdDSA JWT. |
| `limits.ts` | The accounts' limits: each provider's usage endpoint, read through the gateway with the grant Agora gives itself (`limits`), kept a few minutes; `GET /api/limits`. |
| `index.ts` | What the package exports. |

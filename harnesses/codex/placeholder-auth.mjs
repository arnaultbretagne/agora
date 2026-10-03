// codex's auth.json in the sandbox: ChatGPT mode, well-formed but unsigned JWTs, a refresh token that
// is not one, and a last refresh in the future so codex never tries. The gateway sets the real access
// token; the account id (CODEX_ACCOUNT_ID, from the template) is the workspace codex selects, an
// identifier and no credential.
const account = process.env.CODEX_ACCOUNT_ID || 'agora-placeholder'
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.agora`
const exp = Math.floor(Date.parse('2099-01-01T00:00:00Z') / 1000)
const auth = { 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: account, chatgpt_user_id: 'agora-placeholder' } }
process.stdout.write(
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: 'agora@placeholder.invalid', exp, ...auth }),
      access_token: jwt({ exp, ...auth }),
      refresh_token: 'agora-placeholder',
      account_id: account,
    },
    last_refresh: '2099-01-01T00:00:00Z',
  }),
)

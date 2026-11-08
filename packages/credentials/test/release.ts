// A release asset, fetched for the gateway tests. GitHub Releases answers 502, 503 or 504 now and then; each one
// failed a whole CI run. A 5xx or a network error is retried, five tries in all, 1, 2, 4 then 8 s apart; any other
// status is the answer.
import assert from 'node:assert/strict'

export async function fetchRelease(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url).catch((error: unknown) => error as Error)
    const transient = response instanceof Error || response.status >= 500
    if (!transient || attempt === 5) {
      if (response instanceof Error) throw response
      assert.equal(response.status, 200, `download ${url}`)
      return response
    }
    if (!(response instanceof Error)) await response.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
  }
}

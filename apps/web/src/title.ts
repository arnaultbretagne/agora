/**
 * The floor a Workstream is named with at creation, before anything has run.
 *
 * A conversation's real name comes from its Agent (`session_info_update`, read back by
 * `packages/store-pg/src/reads.ts`), but that only arrives at the end of the first turn — and until
 * P12 the gap was filled with the literal `'Untitled'`, which is what every Workstream in production
 * was still called. The first thing the operator typed is a truthful stand-in for the same seconds,
 * and it is what the OLD system used as its own floor.
 *
 * Never overwrites an Agent title and never survives a rename: this is only ever written to
 * `product.workstreams.title` with `title_source = 'auto'`, which is precisely the source both of
 * those outrank.
 */

const MAX_LENGTH = 60

/** Last resort only: a prompt with no text at all (an image, a resource) still has to name its Workstream something, and the column requires 1-200 characters. */
export const FALLBACK_TITLE = 'Nouvelle conversation'

export interface TitleSourceBlock {
  readonly type?: unknown
  readonly text?: unknown
}

/**
 * Truncates on a word boundary when there is one to use, because a title cut mid-word reads as
 * corruption rather than as an abbreviation. Newlines and runs of spaces collapse first: a pasted
 * multi-line prompt would otherwise put its line breaks into a single-line sidebar entry.
 */
export function placeholderTitleFromPrompt(prompt: readonly TitleSourceBlock[]): string {
  const text = prompt
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join(' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()

  if (text.length === 0) return FALLBACK_TITLE
  if (text.length <= MAX_LENGTH) return text

  const cut = text.slice(0, MAX_LENGTH)
  const lastSpace = cut.lastIndexOf(' ')
  // A single 60-character word has no boundary to fall back to; cutting it exactly is better than
  // dropping it for the fallback, which would say nothing at all about the conversation.
  const head = lastSpace > MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut
  return `${head.trimEnd()}…`
}

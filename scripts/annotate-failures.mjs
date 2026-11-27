// Diagnostic only: each failed test as a GitHub Actions annotation, readable through the REST API.
const clean = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
export default async function* annotate(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue
    const { name, file, line, details } = event.data
    const error = details?.error
    if (error?.failureType === 'subtestsFailed') continue
    const cause = error?.cause ?? error
    const text = `${name}: ${cause?.stack ?? cause?.message ?? String(cause)}`.slice(0, 3500)
    yield `::error file=${file ?? ''},line=${line ?? 1}::${clean(text)}\n`
  }
}

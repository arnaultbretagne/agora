// A test reporter for `npm run check` (package.json): in GitHub Actions, each failed test as an error annotation,
// its name and its error, which the REST API serves (check runs' annotations) where the job's log may not be readable.
// Elsewhere it says nothing; the spec reporter beside it prints the run as usual.
const clean = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
export default async function* annotate(source) {
  const on = process.env.GITHUB_ACTIONS === 'true'
  for await (const event of source) {
    if (!on || event.type !== 'test:fail') continue
    const { name, file, line, details } = event.data
    const error = details?.error
    if (error?.failureType === 'subtestsFailed') continue
    const cause = error?.cause ?? error
    const text = `${name}: ${cause?.stack ?? cause?.message ?? String(cause)}`.slice(0, 3500)
    yield `::error file=${file ?? ''},line=${line ?? 1}::${clean(text)}\n`
  }
}

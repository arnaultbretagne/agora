import type { CatalogueView } from '@agora/domain'
import type { RevisionSet } from '@agora/engine'

// S2 stands in for the reviewed capability/harness catalogue that S7 delivers. It validates on
// Intents against a small fixed vocabulary; ENGINE-017's retired-catalogue case is exercised with
// an empty view in the engine tests. S7 replaces this stub.
export const STUB_CATALOGUE: CatalogueView = {
  harnesses: new Set(['claude-code']),
  capabilities: new Set(['provider.invoke', 'workspace.read']),
  models: (harness) => (harness === 'claude-code' ? ['model-a', 'model-b'] : []),
  efforts: (_harness, model) => (model === 'model-a' ? ['default', 'high'] : ['default']),
}

export const STUB_REVISION_SET: RevisionSet = { catalogue: 'stub-s2' }

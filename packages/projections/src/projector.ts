// Projector framework (ADR 0004 — readable models are projections): a projector is a pure fold
// over canonical facts plus versioned persistence. Deterministic and idempotent: the same fact
// range always folds to the same state, so a rebuild can be proved equivalent by hash.
import type pg from 'pg'
import type { FactRecord } from '@agora/journal'

export interface Projector<State> {
  readonly name: string
  /** Bump to adopt a new field or fold change: the runner responds with a full rebuild (ADR 0004). */
  readonly version: string
  emptyState(): State
  /** Load the state persisted by the last run so an incremental run can continue the fold. */
  load(client: pg.PoolClient, workstreamId: string): Promise<State>
  fold(state: State, fact: FactRecord): State
  /** Materialize the folded state into the projector's tables, in the runner's transaction. */
  persist(client: pg.PoolClient, workstreamId: string, state: State): Promise<void>
  /** Delete every projected row for the Workstream — the rebuild precondition. */
  clear(client: pg.PoolClient, workstreamId: string): Promise<void>
  /**
   * Stable lines describing the projected state, independent of physical row order — the input of
   * the rebuild-equivalence hash.
   */
  hashInputs(client: pg.PoolClient, workstreamId: string): Promise<readonly string[]>
}

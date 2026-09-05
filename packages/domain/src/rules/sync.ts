import { ACTION, PASS } from '../results.js'
import type { RuleRow } from './rows.js'

export const SYNC_RULES = [
  {
    id: 'SYNC-001',
    needs: ['observation.sync'],
    when: ({ observation }) => observation('observation.sync') === 'stale',
    result: ACTION('REFILL'),
  },
  {
    id: 'SYNC-002',
    needs: ['observation.sync'],
    when: ({ observation }) => observation('observation.sync') === 'current',
    result: PASS,
  },
] satisfies readonly RuleRow[]

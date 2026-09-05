import { CONVERGED } from '../results.js'
import type { RuleRow } from './rows.js'

export const CONVERGE_RULES = [
  {
    id: 'CONVERGE-001',
    needs: [],
    when: () => true,
    result: CONVERGED,
  },
] satisfies readonly RuleRow[]

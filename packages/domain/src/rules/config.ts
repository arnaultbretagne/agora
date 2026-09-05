import { ACTION, PASS } from '../results.js'
import type { RuleRow } from './rows.js'

export const CONFIG_RULES = [
  {
    id: 'CONFIG-001',
    needs: ['observation.model'],
    when: ({ intent, observation }) => observation('observation.model') !== intent.model,
    result: ACTION('SET_MODEL'),
  },
  {
    id: 'CONFIG-002',
    needs: ['observation.model', 'observation.effort'],
    when: ({ intent, observation }) => observation('observation.model') === intent.model && observation('observation.effort') !== intent.effort,
    result: ACTION('SET_EFFORT'),
  },
  {
    id: 'CONFIG-003',
    needs: ['observation.model', 'observation.effort'],
    when: ({ intent, observation }) => observation('observation.model') === intent.model && observation('observation.effort') === intent.effort,
    result: PASS,
  },
] satisfies readonly RuleRow[]

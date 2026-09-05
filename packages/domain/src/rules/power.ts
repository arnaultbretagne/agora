import { ACTION, CONVERGED, PASS } from '../results.js'
import type { RuleRow } from './rows.js'

export const POWER_RULES = [
  {
    id: 'POWER-001',
    needs: ['observation.power'],
    when: ({ intent, observation }) => intent.power === 'off' && observation('observation.power') === 'off',
    result: CONVERGED,
  },
  {
    id: 'POWER-002',
    needs: ['observation.power'],
    when: ({ intent, observation }) => intent.power === 'off' && observation('observation.power') === 'on',
    result: ACTION('TURN_OFF'),
  },
  {
    id: 'POWER-003',
    needs: [],
    when: ({ intent }) => intent.power === 'on',
    result: PASS,
  },
] satisfies readonly RuleRow[]

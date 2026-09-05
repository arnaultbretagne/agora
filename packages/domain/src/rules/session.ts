import { ACTION, HOLD, PASS } from '../results.js'
import type { RuleRow } from './rows.js'

export const SESSION_RULES = [
  {
    id: 'SESSION-005',
    needs: ['observation.session'],
    when: ({ observation }) => observation('observation.session') === 'unusable',
    result: ACTION('TURN_OFF'),
  },
  {
    id: 'SESSION-001',
    needs: ['observation.session'],
    when: ({ observation }) => observation('observation.session') === 'pending',
    result: HOLD,
  },
  {
    id: 'SESSION-002',
    needs: ['observation.session', 'observation.anchor'],
    when: ({ observation }) => observation('observation.session') === 'openable' && observation('observation.anchor') === 'compatible',
    result: ACTION('RESTORE'),
  },
  {
    id: 'SESSION-003',
    needs: ['observation.session', 'observation.anchor'],
    when: ({ observation }) => observation('observation.session') === 'openable' && observation('observation.anchor') === 'none',
    result: ACTION('START'),
  },
  {
    id: 'SESSION-004',
    needs: ['observation.session'],
    when: ({ observation }) => observation('observation.session') === 'live',
    result: PASS,
  },
] satisfies readonly RuleRow[]

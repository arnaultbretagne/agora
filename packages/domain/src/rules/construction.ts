import { isConstructionEmpty, isExactlyConstruction } from '../observation.js'
import { ACTION, PASS } from '../results.js'
import type { RuleRow } from './rows.js'

export const CONSTRUCTION_RULES = [
  {
    id: 'CONSTRUCT-001',
    needs: ['observation.construction'],
    when: ({ observation }) => isConstructionEmpty(observation('observation.construction')),
    result: ACTION('BUILD'),
  },
  {
    id: 'CONSTRUCT-002',
    needs: ['observation.construction'],
    when: ({ intent, observation, resolve }) => {
      const constructed = observation('observation.construction')
      return !isConstructionEmpty(constructed) && !isExactlyConstruction(constructed, resolve.harnessDigest(intent.harness))
    },
    result: ACTION('TURN_OFF'),
  },
  {
    id: 'CONSTRUCT-003',
    needs: ['observation.construction'],
    when: ({ intent, observation, resolve }) => isExactlyConstruction(observation('observation.construction'), resolve.harnessDigest(intent.harness)),
    result: PASS,
  },
] satisfies readonly RuleRow[]

import { equals, grantUnion, isSubset } from '../authorization.js'
import type { Authorization } from '../authorization.js'
import { ACTION, HOLD, PASS } from '../results.js'
import type { RuleFieldReader, RuleRow } from './rows.js'

function desired(input: RuleFieldReader): ReadonlySet<Authorization> {
  return input.resolve.capabilityGrants(input.intent.capabilities)
}

function attached(input: RuleFieldReader): ReadonlySet<Authorization> {
  return input.observation('observation.grants.attached')
}

function effective(input: RuleFieldReader): ReadonlySet<Authorization> {
  return input.observation('observation.grants.effective')
}

export const CAPABILITIES_RULES = [
  {
    id: 'CAPS-001',
    needs: ['observation.grants.attached', 'observation.grants.effective'],
    when: (input) => !isSubset(grantUnion(attached(input), effective(input)), desired(input)),
    result: ACTION('REVOKE'),
  },
  {
    id: 'CAPS-002',
    needs: ['observation.grants.attached', 'observation.grants.effective'],
    when: (input) => isSubset(grantUnion(attached(input), effective(input)), desired(input)) && !isSubset(desired(input), attached(input)),
    result: ACTION('GRANT'),
  },
  {
    id: 'CAPS-004',
    needs: ['observation.grants.attached', 'observation.grants.effective'],
    when: (input) => equals(attached(input), desired(input)) && isSubset(effective(input), desired(input)) && !equals(effective(input), desired(input)),
    result: HOLD,
  },
  {
    id: 'CAPS-003',
    needs: ['observation.grants.attached', 'observation.grants.effective'],
    when: (input) => equals(attached(input), desired(input)) && equals(effective(input), desired(input)),
    result: PASS,
  },
] satisfies readonly RuleRow[]

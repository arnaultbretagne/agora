// The envelope as label/value rows, for the Approval card.
import { BRANCH, CRITERIA, DEV, FEATURE, JUDGE, LIMITS } from './data'

export const DETAILS = [
  { label: 'Feature', value: `${FEATURE} · ${BRANCH}` },
  { label: 'Criteria', value: CRITERIA.join(' · ') },
  { label: 'dev-1', value: `${DEV.harness} · ${DEV.rights.join(', ')}` },
  { label: 'Judge', value: JUDGE },
  { label: 'Limits', value: LIMITS },
]

import type { RuleTable } from './rows.js'
import { CAPABILITIES_RULES } from './capabilities.js'
import { CONFIG_RULES } from './config.js'
import { CONSTRUCTION_RULES } from './construction.js'
import { CONVERGE_RULES } from './converge.js'
import { POWER_RULES } from './power.js'
import { SESSION_RULES } from './session.js'
import { SYNC_RULES } from './sync.js'

export const ORDERED_RULES = [
  { file: '004_power', rows: POWER_RULES },
  { file: '005_construction', rows: CONSTRUCTION_RULES },
  { file: '006_capabilities', rows: CAPABILITIES_RULES },
  { file: '007_session', rows: SESSION_RULES },
  { file: '008_config', rows: CONFIG_RULES },
  { file: '009_sync', rows: SYNC_RULES },
  { file: '010_converge', rows: CONVERGE_RULES },
] as const satisfies readonly RuleTable[]

export type OrderedRules = typeof ORDERED_RULES

import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { EXIT_DISCIPLINE_PARAMS } from '../../config/difficulty.market'
import View from './View'

const exitDiscipline: GameDefinition = {
  id: 'exit_discipline', kind: 'market', category: 'reasoning', title: 'Exit Discipline',
  blurb: 'Manage an open trade to its best exit.',
  instructions: [
    'A trade is already on, in the direction shown. Before the replay starts, set your plan: a stop and a target distance in points.',
    'Then the replay runs. The stop and target are enforced for you. You may EXIT, TRAIL TO COST (stop to your entry) or LOCK half the open profit.',
    'You are scored on how much of the best available result you captured. Overriding a good plan and ending worse costs points.',
    'Early levels fill in a suggested plan; later ones leave it blank. Your stop must stay within half to one and a half times the suggested one.',
  ],
  paramTable: EXIT_DISCIPLINE_PARAMS,
  // The score is a capture ratio against the best exit the window offered, which nobody can know in advance: 70 is out of reach, so this game levels at 50 and 20 (C36).
  levelRules: { upThreshold: 50, downThreshold: 20 },
  roundsPerSession: level => paramsAt(EXIT_DISCIPLINE_PARAMS, level).rounds,
  reducedMotionParams: params => ({ ...params, speed: params.speed * 0.7 }),
  View,
}
export default exitDiscipline

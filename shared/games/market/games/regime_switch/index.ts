import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { REGIME_SWITCH_PARAMS } from '../../config/difficulty.market'
import View from './View'

const regimeSwitch: GameDefinition = {
  id: 'regime_switch', kind: 'market', category: 'flexibility', title: 'Regime Switch',
  blurb: 'Change playbook when the market changes.',
  instructions: [
    'You see a stretch of price from an unnamed market. Choose a playbook: FOLLOW the last 30 seconds, FADE them, or STAND ASIDE.',
    'The next seconds replay and the three playbooks are ranked on their result after costs: the best scores 100%, the second 50%, the worst 0.',
    'The market changes character every few segments (trend up or down, range, spike). Repeating what just worked after it changed costs points.',
    'After each segment you see the regime and which playbook was best. Early levels also show the previous regime.',
  ],
  paramTable: REGIME_SWITCH_PARAMS,
  roundsPerSession: level => paramsAt(REGIME_SWITCH_PARAMS, level).segments,
  reducedMotionParams: params => ({ ...params, replaySpeed: params.replaySpeed * 0.7 }),
  View,
}
export default regimeSwitch

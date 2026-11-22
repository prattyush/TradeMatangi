import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { RISK_CALCULATOR_PARAMS } from '../../config/difficulty.market'
import View from './View'

const riskCalculator: GameDefinition = {
  id: 'risk_calculator', kind: 'market', category: 'math', title: 'Risk Calculator',
  blurb: 'Size positions and risk fast and correctly.',
  instructions: [
    'Each question is a quick piece of options risk arithmetic: rupee risk, reward to risk, breakeven, lots for a budget.',
    'Type the number and press Enter. Rounding to two decimal places is accepted.',
    'Faster correct answers score more; a close answer counts as half; a wrong or late one scores nothing.',
    'More question types and more steps unlock as you level up. The working is shown after each answer.',
  ],
  paramTable: RISK_CALCULATOR_PARAMS,
  roundsPerSession: level => paramsAt(RISK_CALCULATOR_PARAMS, level).questions,
  View,
}
export default riskCalculator

import type { TrialGameDefinition } from '../../../core/types'
import { CODE_BREAKER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import View from './View'
import { createCodeBreakerEngine, summariseCodeBreaker, type CbResponse, type CbTrial } from './engine'

const codeBreaker: TrialGameDefinition<CbTrial, CbResponse> = {
  id: 'code_breaker', kind: 'trial', category: 'reasoning', title: 'Code Breaker',
  blurb: 'Deduce the hidden code from the feedback.',
  instructions: [
    'A hidden code is a row of symbols. Make a guess; you are told how many symbols are right and in the right place (exact) and how many are right but in the wrong place (misplaced).',
    'Use the feedback to rule codes out and find the code within the guess limit. Press 1 to 8 to place a symbol, Backspace to undo, Enter to guess.',
    'Early levels never repeat a symbol in the code; from level 10 symbols can repeat. From level 16 one feedback number per code is hidden ("?") once.',
    'You score for solving the code in as few guesses as a careful solver, and a little extra if every guess could still have been the code. Six codes.',
  ],
  paramTable: CODE_BREAKER_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.code_breaker },
  createEngine: createCodeBreakerEngine,
  summarise: summariseCodeBreaker,
  View,
}
export default codeBreaker

import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, RULE_SWITCH_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createRuleSwitchEngine, summariseRuleSwitch, type RsResponse, type RsTrial } from './engine'

const ruleSwitch: TrialGameDefinition<RsTrial, RsResponse> = {
  id: 'rule_switch', kind: 'trial', category: 'flexibility', title: 'Rule Switch',
  blurb: 'Apply the rule the cue asks for.',
  instructions: [
    'A card shows a digit and a letter. A cue says which one to judge: the NUMBER rule (odd or even) or the LETTER rule (vowel or consonant).',
    'Press F for odd or vowel, J for even or consonant. The cue always lists the two keys.',
    'The rule changes from card to card. At first the pattern is predictable; later it is random and the cue comes with the card.',
    'From level 16 a third rule is added: SIZE (F = over 5, J = under 5).',
    'You have 75 seconds. Fast and accurate scores best; guessing scores nothing.',
  ],
  paramTable: RULE_SWITCH_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.rule_switch },
  createEngine: createRuleSwitchEngine,
  summarise: summariseRuleSwitch,
  View,
}
export default ruleSwitch

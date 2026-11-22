import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, N_BACK_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createNBackEngine, summariseNBack, type NbResponse, type NbTrial } from './engine'

const nBackStream: TrialGameDefinition<NbTrial, NbResponse> = {
  id: 'n_back_stream', kind: 'trial', category: 'memory', title: 'N-Back Stream',
  blurb: 'Spot when an item repeats from n steps back.',
  instructions: [
    'Letters appear one at a time at a steady pace. Press M when the letter is the same as the one n steps back.',
    'n grows with your level (1, 2, 3, then 4). The first n letters are only for remembering.',
    'From level 10 near misses appear (one step off) that you must not press for.',
    'From level 16 the letter also moves around a grid: press A for the same place, L for the same letter, or both.',
    'About 90 seconds. Pressing every time or never scores nothing.',
  ],
  paramTable: N_BACK_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.n_back_stream },
  createEngine: createNBackEngine,
  summarise: summariseNBack,
  View,
}
export default nBackStream

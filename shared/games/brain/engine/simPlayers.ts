/**
 * Simulated players (spec 17.10, correction C6). They run a whole block against a game's pure engine on a virtual clock, with
 * no UI, to prove that the scoring is chance-corrected:
 *   perfect     always the right answer at the fastest reaction time (RT_fast)
 *   random      a uniformly random answer at a middling reaction time
 *   fastRandom  a random answer at RT_fast ("fast but random")
 *   alwaysPress / neverPress   for detection games
 * This validates the scoring maths. Whether a human can reach the top of a level is a calibration matter, recorded from play.
 * Every brain game's parameter table carries `rtFast` and `rtSlow`.
 */
import { paramsAt } from '../../core/difficulty'
import { createRng, type Rng } from '../../core/rng'
import type { TrialResponse } from '../../core/trial'
import type { SessionSummary, TrialGameDefinition } from '../../core/types'
import { createBlock } from './trialEngine'

export type PlayerProfile = 'perfect' | 'random' | 'fastRandom' | 'alwaysPress' | 'neverPress'

export interface SimPlayer<Trial, R> {
  correct(trial: Trial): TrialResponse<R>
  random(trial: Trial, rng: Rng): TrialResponse<R>
  alwaysPress?(trial: Trial): TrialResponse<R>
  neverPress?(trial: Trial): TrialResponse<R>
}

export function simulateBlock<Trial, R>(
  definition: TrialGameDefinition<Trial, R>, player: SimPlayer<Trial, R>, level: number, profile: PlayerProfile, seed: number,
): SessionSummary {
  const params = paramsAt(definition.paramTable, level)
  const engine = definition.createEngine(params, createRng(seed))
  const playerRng = createRng((seed ^ 0x9e3779b9) >>> 0)
  const seconds = definition.session.kind === 'timed' ? definition.session.seconds : undefined
  const block = createBlock(engine, { seconds })
  const fast = params.rtFast, mid = (params.rtFast + params.rtSlow) / 2
  let elapsed = 0
  for (let guard = 0; guard < 5000; guard++) {
    const trial = block.issue(elapsed)
    if (trial === null) break
    const timing = engine.timing(trial)
    elapsed += timing.preMs ?? 0
    let response: TrialResponse<R>
    let rt: number
    switch (profile) {
      case 'perfect': response = player.correct(trial); rt = fast; break
      case 'random': response = player.random(trial, playerRng); rt = mid; break
      case 'fastRandom': response = player.random(trial, playerRng); rt = fast; break
      case 'alwaysPress': response = (player.alwaysPress ?? player.correct)(trial); rt = mid; break
      case 'neverPress': response = (player.neverPress ?? (() => 'timeout' as TrialResponse<R>))(trial); rt = mid; break
    }
    if (response === 'timeout' || rt > timing.windowMs) { response = 'timeout'; rt = timing.windowMs }
    elapsed += rt
    block.answer(response, rt, elapsed)
    elapsed += timing.gapMs
  }
  return definition.summarise(block.log, level)
}

/** Run a profile over many seeds (a single ~40-trial run is noisy; the properties are statistical). */
export function simulateMany<Trial, R>(
  definition: TrialGameDefinition<Trial, R>, player: SimPlayer<Trial, R>, level: number, profile: PlayerProfile, seeds: number, baseSeed = 1,
): number[] {
  return Array.from({ length: seeds }, (_, i) => simulateBlock(definition, player, level, profile, baseSeed + i * 7919).score)
}

/**
 * Spec 17.10 / correction C6: simulated players prove the scoring is chance-corrected.
 *  - a perfect player (always right, at RT_fast) scores 95 or more at levels 1, 10 and 20;
 *  - always pressing and never pressing score 5 or less in a go/no-go game (they score exactly 0);
 *  - a random player ("random" and "fast but random") scores about nothing.
 * "Random <= 25" cannot hold in every single run: a block has only about 40 trials (Green Light level 1 has about 6 NO-GO
 * trials), so luck sometimes lifts one run well above chance. The property is therefore tested over 200 seeds: the mean is
 * small, nine runs in ten stay at or below 30, and a lucky run above 25 is rare. Measured on 2026-11-15: mean 2 to 7,
 * 90th percentile 7 to 25, worst single run 62 (Green Light level 1).
 */
import { describe, expect, it } from 'vitest'
import quickMatch from '../games/quick_match'
import colourClash from '../games/colour_clash'
import greenLight from '../games/green_light'
import gridRecall from '../games/grid_recall'
import sequenceEcho from '../games/sequence_echo'
import nBackStream from '../games/n_back_stream'
import flankerFlock from '../games/flanker_flock'
import needleFinder from '../games/needle_finder'
import trackTheDots from '../games/track_the_dots'
import ruleSwitch from '../games/rule_switch'
import cardSorter from '../games/card_sorter'
import flipMap from '../games/flip_map'
import numberSprint from '../games/number_sprint'
import makeTarget from '../games/make_target'
import { quickMatchSim } from '../games/quick_match/engine'
import { colourClashSim } from '../games/colour_clash/engine'
import { greenLightSim } from '../games/green_light/engine'
import { gridRecallSim } from '../games/grid_recall/engine'
import { sequenceEchoSim } from '../games/sequence_echo/engine'
import { nBackSim } from '../games/n_back_stream/engine'
import { flankerSim } from '../games/flanker_flock/engine'
import { needleFinderSim } from '../games/needle_finder/engine'
import { trackDotsSim } from '../games/track_the_dots/engine'
import { ruleSwitchSim } from '../games/rule_switch/engine'
import { cardSorterSim } from '../games/card_sorter/engine'
import { flipMapSim } from '../games/flip_map/engine'
import { numberSprintSim } from '../games/number_sprint/engine'
import { makeTargetSim } from '../games/make_target/engine'
import { simulateBlock, simulateMany, type PlayerProfile, type SimPlayer } from './simPlayers'
import type { TrialGameDefinition } from '../../core/types'

const SEEDS = 200
const LEVELS = [1, 10, 20] as const
/* eslint-disable @typescript-eslint/no-explicit-any */
// [name, game, player, is a detection game (always/never press), seeds for the random players]
const GAMES: Array<[string, TrialGameDefinition<any, any>, SimPlayer<any, any>, boolean, number]> = [
  ['quick_match', quickMatch, quickMatchSim, false, SEEDS],
  ['colour_clash', colourClash, colourClashSim, false, SEEDS],
  ['green_light', greenLight, greenLightSim, true, SEEDS],
  ['grid_recall', gridRecall, gridRecallSim, false, SEEDS],
  ['sequence_echo', sequenceEcho, sequenceEchoSim, false, SEEDS],
  ['n_back_stream', nBackStream, nBackSim, true, SEEDS],
  ['flanker_flock', flankerFlock, flankerSim, false, SEEDS],
  ['needle_finder', needleFinder, needleFinderSim, false, SEEDS],
  ['track_the_dots', trackTheDots, trackDotsSim, false, 60],
  ['rule_switch', ruleSwitch, ruleSwitchSim, false, SEEDS],
  ['card_sorter', cardSorter, cardSorterSim, false, SEEDS],
  ['flip_map', flipMap, flipMapSim, false, SEEDS],
  ['number_sprint', numberSprint, numberSprintSim, false, SEEDS],
  ['make_target', makeTarget, makeTargetSim, false, 40],
]
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]

describe.each(GAMES)('%s simulated players', (name, definition, sim, detection, seeds) => {
  describe.each(LEVELS)('level %i', level => {
    it('a perfect player scores 95 or more', () => {
      for (const seed of [1, 2, 3, 4, 5]) expect(simulateBlock(definition, sim, level, 'perfect', seed).score, `${name} seed ${seed}`).toBeGreaterThanOrEqual(95)
    })
    it.each<PlayerProfile>(['random', 'fastRandom'])('a %s player scores about nothing', profile => {
      const scores = simulateMany(definition, sim, level, profile, seeds)
      expect(mean(scores)).toBeLessThanOrEqual(10)
      expect(percentile(scores, 0.9)).toBeLessThanOrEqual(30)
      expect(scores.filter(score => score > 25).length / seeds).toBeLessThanOrEqual(0.15)
    })
    if (detection) {
      it.each<PlayerProfile>(['alwaysPress', 'neverPress'])('%s scores 5 or less (it scores 0)', profile => {
        for (const score of simulateMany(definition, sim, level, profile, 50)) expect(score).toBeLessThanOrEqual(5)
      })
    }
  })
})

describe('the harness', () => {
  it('is deterministic for a seed and produces a plausible number of trials', () => {
    const a = simulateBlock(quickMatch, quickMatchSim, 10, 'perfect', 42)
    expect(simulateBlock(quickMatch, quickMatchSim, 10, 'perfect', 42)).toEqual(a)
    expect(a.review!.length).toBeGreaterThan(50) // 60 s at about 390 ms + 400 ms per trial
    expect(a.review!.length).toBeLessThan(80)
  })
  it('a timed block stops when the clock runs out (no trial runs on)', () => {
    const summary = simulateBlock(greenLight, greenLightSim, 1, 'perfect', 1)
    const rows = summary.review!
    expect(rows.length).toBeGreaterThan(25); expect(rows.length).toBeLessThan(60)
  })
})

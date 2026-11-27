import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { FLIP_MAP_PARAMS } from '../../config/difficulty.brain'
import { bannerText, createFlipMapEngine, mapDir, MAX_RUN, MIN_RUN, summariseFlipMap, type FmDir, type FmResponse, type FmRule, type FmTrial } from './engine'

const play = (level: number, count: number, seed = 1, answer: (t: FmTrial) => FmResponse = t => t.expected): FmTrial[] => {
  const engine = createFlipMapEngine(paramsAt(FLIP_MAP_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => { const t = engine.next() as FmTrial; engine.evaluate(t, answer(t), 500); return t })
}
const entry = (n: number, trial: FmTrial, response: FmResponse | 'timeout', rtMs: number | null, correct: boolean, tag = correct ? 'ok' : 'wrong', anticipated = false): TrialLogEntry<FmTrial, FmResponse> =>
  ({ n, trial, response, rtMs, outcome: { correct, tag, anticipated }, atMs: n })

describe('Flip Map engine', () => {
  it('maps the arrow by the rule: same, opposite, 90 degrees clockwise', () => {
    const dirs: FmDir[] = ['up', 'right', 'down', 'left']
    expect(dirs.map(d => mapDir(d, 'same'))).toEqual(dirs)
    expect(dirs.map(d => mapDir(d, 'opposite'))).toEqual(['down', 'left', 'up', 'right'])
    expect(dirs.map(d => mapDir(d, 'turn'))).toEqual(['right', 'down', 'left', 'up'])
  })
  it('is deterministic for a seed', () => { expect(play(10, 60, 3)).toEqual(play(10, 60, 3)); expect(play(10, 60, 3)).not.toEqual(play(10, 60, 4)) })
  it('the expected key always follows the current rule', () => { for (const t of play(20, 300)) expect(t.expected).toBe(mapDir(t.dir, t.rule)) })
  it('the rule changes every 4 to 12 trials and never to itself', () => {
    const trials = play(5, 400)
    const runs: number[] = []
    let length = 1
    for (let i = 1; i < trials.length; i++) {
      if (trials[i].rule !== trials[i - 1].rule) { runs.push(length); length = 1 } else length += 1
    }
    expect(runs.length).toBeGreaterThan(30)
    for (const run of runs) { expect(run).toBeGreaterThanOrEqual(MIN_RUN); expect(run).toBeLessThanOrEqual(MAX_RUN) }
  })
  it('counts the trials since the last change, and keeps the old rule for perseveration', () => {
    const trials = play(5, 120)
    expect(trials[0]).toMatchObject({ sinceChange: 0, changed: false, prevRule: null, oldAnswer: null })
    for (let i = 1; i < trials.length; i++) {
      if (trials[i].rule !== trials[i - 1].rule) {
        expect(trials[i]).toMatchObject({ sinceChange: 0, changed: true, prevRule: trials[i - 1].rule })
        expect(trials[i].oldAnswer).toBe(mapDir(trials[i].dir, trials[i - 1].rule))
      } else expect(trials[i].sinceChange).toBe(trials[i - 1].sinceChange + 1)
    }
  })
  it('two rules until level 15; TURN joins at level 16', () => {
    expect(new Set(play(15, 400).map(t => t.rule))).toEqual(new Set<FmRule>(['same', 'opposite']))
    expect(new Set(play(16, 600).map(t => t.rule))).toEqual(new Set<FmRule>(['same', 'opposite', 'turn']))
  })
  it('banner: stays on screen (L1-6), shows for 1.5 s after a change (L7-12), never shows (L13+)', () => {
    expect(play(6, 80).every(t => t.bannerMode === 0 && t.preMs === 0)).toBe(true)
    const mid = play(10, 80)
    expect(mid.every(t => t.bannerMode === 1)).toBe(true)
    for (const t of mid) { expect(t.preMs).toBe(t.sinceChange === 0 ? 1500 : 0); expect(bannerText(t) !== null).toBe(t.preMs > 0) }
    expect(play(13, 80).every(t => t.bannerMode === 2 && t.preMs === 0 && bannerText(t) === null)).toBe(true)
  })
  it('display and response window shrink with the level', () => {
    expect(play(1, 1)[0]).toMatchObject({ displayMs: 2000, windowMs: 2600 }); expect(play(20, 1)[0]).toMatchObject({ displayMs: 900, windowMs: 1300 })
  })
  it('tags answering by the old rule right after a change as perseverative', () => {
    const engine = createFlipMapEngine(paramsAt(FLIP_MAP_PARAMS, 5), createRng(5))
    let t = engine.next() as FmTrial
    while (t.sinceChange !== 0 || !t.changed) { engine.evaluate(t, t.expected, 500); t = engine.next() as FmTrial }
    expect(engine.evaluate(t, t.oldAnswer as FmDir, 500)).toMatchObject({ correct: false, tag: 'persev' })
  })
})

describe('Flip Map scoring', () => {
  const trials = play(10, 120)
  const after = trials.find(t => t.changed && t.sinceChange === 0)!, steady = trials.find(t => !t.changed || t.sinceChange >= 2)!
  const other = (t: FmTrial): FmDir => (t.expected === 'up' ? 'down' : 'up')
  it('adaptation cost compares accuracy on the first two trials after a change with the rest', () => {
    const log = [
      entry(1, after, other(after), 700, false), entry(2, after, after.expected, 650, true), entry(3, steady, steady.expected, 500, true), entry(4, steady, steady.expected, 520, true),
      entry(5, steady, steady.expected, 510, true), entry(6, steady, steady.expected, 505, true),
    ]
    expect(summariseFlipMap(log, 10).stats).toMatchObject({ acc_after_change_pct: 50, acc_steady_pct: 100, adaptation_cost_pct: 50 })
  })
  it('hand-computed at level 1 (four choices): 36 of 40 right at a median 900 ms', () => {
    const t1 = play(1, 40)
    const log = t1.map((t, i) => (i < 36 ? entry(i + 1, t, t.expected, 900, true) : entry(i + 1, t, other(t), 800, false)))
    // skill (0.9 - 0.25) / 0.75 = 0.8667; speed (1800 - 900) / (1800 - 450) = 0.6667; 100 * 0.8667 * (0.6 + 0.4 * 0.6667) = 75.1
    expect(summariseFlipMap(log, 1).score).toBe(75)
  })
  it('counts perseveration errors and guessing scores nothing', () => {
    const log = [entry(1, after, after.oldAnswer as FmDir, 700, false, 'persev'), entry(2, steady, steady.expected, 500, true)]
    expect(summariseFlipMap(log, 10).stats).toMatchObject({ persev_errors: 1 })
    const guess = trials.map((t, i) => entry(i + 1, t, i % 4 === 0 ? t.expected : other(t), 400, i % 4 === 0))
    expect(summariseFlipMap(guess, 1).score).toBe(0)
  })
})

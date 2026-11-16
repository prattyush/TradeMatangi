import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../../core/settings'
import { HOTKEY_DRILL, HOTKEY_DRILL_PARAMS } from '../../config/difficulty.market'
import { DEFAULT_KEYS, normalizeKeys } from '../../engine/hotkeys'
import '../../../games'
import View from './View'
import { createDrill, describePrompt, isDrillKey, makePrompt, summariseHotkeyDrill, type Prompt, type PromptParams, type PromptResult } from './engine'

const prompt = (id: number, steps: Prompt['steps'], ignore = false): Prompt => ({ id, steps, ignore, text: describePrompt(steps) })
const type = (drill: ReturnType<typeof createDrill>, keys: string[], at = 0) => keys.map(key => drill.press({ key }, at))

describe('the mock panel', () => {
  it('BUY CE 2 lots: set the lots, stage the action, confirm', () => {
    const drill = createDrill(); drill.start(prompt(1, [{ action: 'buy_ce', lots: 2 }]), 1000)
    const out = type(drill, ['2', 'c'], 1100); expect(out.map(o => o.kind)).toEqual(['lots', 'staged'])
    expect(drill.panel).toEqual({ lots: 2, staged: 'buy_ce' })
    expect(drill.press({ key: 'Enter' }, 1650)).toEqual({ kind: 'prompt_done', rtMs: 650 })
    expect(drill.results()).toEqual([{ id: 1, steps: 1, kind: 'done', rtMs: 650, errors: [] }])
    expect(drill.current).toBeNull()
  })
  it('arrows change the lots between 1 and 5 and the letters are case-insensitive', () => {
    const drill = createDrill(); drill.start(prompt(1, [{ action: 'buy_pe', lots: 3 }]), 0)
    type(drill, ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'])
    expect(drill.panel.lots).toBe(5); type(drill, ['ArrowDown', 'ArrowDown']); expect(drill.panel.lots).toBe(3)
    type(drill, ['P']); expect(drill.panel.staged).toBe('buy_pe'); expect(drill.press({ key: 'Enter' }, 500).kind).toBe('prompt_done')
    drill.start(prompt(2, [{ action: 'buy_ce', lots: 1 }]), 0); type(drill, ['ArrowDown', 'ArrowDown']); expect(drill.panel.lots).toBe(1)
  })
  it('every kind of fat-finger is an error, the prompt stays, and the player can correct and finish', () => {
    const drill = createDrill(); drill.start(prompt(1, [{ action: 'buy_ce', lots: 2 }]), 0)
    expect(drill.press({ key: 'Enter' }, 10)).toEqual({ kind: 'error', error: 'nothing_staged' })
    type(drill, ['x']); expect(drill.press({ key: 'Enter' }, 20)).toEqual({ kind: 'error', error: 'wrong_action' })
    type(drill, ['p']); expect(drill.press({ key: 'Enter' }, 30)).toEqual({ kind: 'error', error: 'wrong_side' })
    type(drill, ['c']); expect(drill.press({ key: 'Enter' }, 40)).toEqual({ kind: 'error', error: 'wrong_lots' })
    expect(drill.press({ key: 'q' }, 50)).toEqual({ kind: 'error', error: 'wrong_key' })
    type(drill, ['2']); expect(drill.press({ key: 'Enter' }, 900).kind).toBe('prompt_done')
    expect(drill.results()[0].errors).toEqual(['nothing_staged', 'wrong_action', 'wrong_side', 'wrong_lots', 'wrong_key'])
    expect(drill.openErrors).toBe(0)
  })
  it('a chain needs each step in turn and reports the whole reaction time', () => {
    const drill = createDrill(); drill.start(prompt(1, [{ action: 'buy_pe', lots: 1 }, { action: 'stop_cost' }]), 100)
    type(drill, ['p']); expect(drill.press({ key: 'Enter' }, 400)).toEqual({ kind: 'step_done', stepIndex: 0 }); expect(drill.stepIndex).toBe(1)
    expect(drill.panel).toEqual({ lots: 1, staged: null })
    type(drill, ['p']); expect(drill.press({ key: 'Enter' }, 500)).toEqual({ kind: 'error', error: 'wrong_action' })
    type(drill, ['s']); expect(drill.press({ key: 'Enter' }, 1100)).toEqual({ kind: 'prompt_done', rtMs: 1000 })
    expect(drill.results()[0]).toMatchObject({ steps: 2, rtMs: 1000, errors: ['wrong_action'] })
  })
  it('exit all and stop to cost do not care about the lots', () => {
    const drill = createDrill(); drill.start(prompt(1, [{ action: 'exit_all' }]), 0); type(drill, ['4', 'x']); expect(drill.press({ key: 'Enter' }, 100).kind).toBe('prompt_done')
  })
  it('an ignore cue: any key is an error that ends it, no key is a correct ignore', () => {
    const drill = createDrill(); drill.start(prompt(1, [], true), 0)
    expect(drill.press({ key: 'c' }, 50)).toEqual({ kind: 'ignored_cue_error' }); expect(drill.results()[0]).toMatchObject({ kind: 'ignored', errors: ['ignored_cue'] })
    drill.start(prompt(2, [], true), 0); drill.settleIgnore(); expect(drill.results()[1]).toMatchObject({ kind: 'ignored', errors: [] })
  })
  it('a prompt that runs out is a miss; one open at the end of a block is dropped; modifier keys and nothing-on-screen are ignored', () => {
    const drill = createDrill(); drill.start(prompt(1, [{ action: 'exit_all' }]), 0)
    expect(drill.press({ key: 'c', ctrlKey: true }, 1)).toEqual({ kind: 'ignored_key' }); expect(drill.press({ key: 'Tab' }, 1)).toEqual({ kind: 'ignored_key' }); expect(drill.press({ key: 'Shift' }, 1)).toEqual({ kind: 'ignored_key' })
    drill.expire(); expect(drill.results()[0]).toMatchObject({ kind: 'missed', errors: ['missed'] })
    expect(drill.press({ key: 'c' }, 2)).toEqual({ kind: 'ignored_key' })
    drill.start(prompt(2, [{ action: 'exit_all' }]), 0); drill.abandon(); expect(drill.results().length).toBe(1)
    expect([isDrillKey({ key: 'a' }), isDrillKey({ key: 'Enter' }), isDrillKey({ key: 'ArrowUp' }), isDrillKey({ key: 'F5' }), isDrillKey({ key: 'Escape' }), isDrillKey({ key: 'a', metaKey: true })]).toEqual([true, true, true, false, false, false])
  })
  it('follows a custom key map', () => {
    const keys = normalizeKeys({ buyCe: 'q', buyPe: 'w', exitAll: 'e', stopCost: 'r' })
    const drill = createDrill(keys); drill.start(prompt(1, [{ action: 'buy_ce', lots: 1 }]), 0)
    expect(drill.press({ key: 'c' }, 1)).toEqual({ kind: 'error', error: 'wrong_key' }); type(drill, ['q']); expect(drill.press({ key: 'Enter' }, 9).kind).toBe('prompt_done')
  })
})

describe('prompts', () => {
  const params: PromptParams = { maxChain: 3, ignoreShare: 0.2, lotsMax: 4 }
  it('are deterministic, within the chain and lots limits, never repeat an action back to back, and mix in ignore cues', () => {
    const draw = (seed: number) => { const rng = createRng(seed); return Array.from({ length: 300 }, (_, i) => makePrompt(rng, i, params)) }
    expect(draw(3)).toEqual(draw(3))
    const all = draw(3)
    expect(all.filter(p => p.ignore).length / 300).toBeGreaterThan(0.1); expect(all.filter(p => p.ignore).length / 300).toBeLessThan(0.3)
    for (const p of all.filter(x => !x.ignore)) {
      expect(p.steps.length).toBeGreaterThanOrEqual(1); expect(p.steps.length).toBeLessThanOrEqual(3)
      p.steps.forEach((s, i) => { if (i) expect(s.action).not.toBe(p.steps[i - 1].action); if (s.lots !== undefined) { expect(s.lots).toBeGreaterThanOrEqual(1); expect(s.lots).toBeLessThanOrEqual(4) } })
      expect(p.text).toBe(describePrompt(p.steps))
    }
    expect(new Set(all.filter(p => !p.ignore).flatMap(p => p.steps.map(s => s.action)))).toEqual(new Set(['buy_ce', 'buy_pe', 'exit_all', 'stop_cost']))
    expect(describePrompt([{ action: 'buy_ce', lots: 1 }, { action: 'stop_cost' }])).toBe('BUY CE 1 lot → STOP TO COST')
    const level1 = Array.from({ length: 100 }, (_, i) => makePrompt(createRng(i), i, { maxChain: 1, ignoreShare: 0, lotsMax: 2 }))
    expect(level1.every(p => !p.ignore && p.steps.length === 1)).toBe(true)
  })
})

describe('scoring', () => {
  const done = (rt: number, steps = 1, errors: PromptResult['errors'] = []): PromptResult => ({ id: 1, steps, kind: 'done', rtMs: rt, errors })
  it('score = 100 x accuracy x (0.4 + 0.6 x speed): fast and clean is 100, slow and clean is 40', () => {
    expect(summariseHotkeyDrill(Array.from({ length: 20 }, () => done(600)), 2500).score).toBe(100)
    expect(summariseHotkeyDrill(Array.from({ length: 20 }, () => done(2500)), 2500).score).toBe(40)
    expect(summariseHotkeyDrill(Array.from({ length: 20 }, () => done(1550)), 2500).score).toBe(70)
  })
  it('a chain is judged per step, so a three-step prompt in three times the time is as fast as a single', () => {
    expect(summariseHotkeyDrill([done(1800, 3), done(600, 1)], 2500).stats!.median_rt_ms).toBe(600)
  })
  it('errors lower the accuracy and more than 15 % caps the score at 60', () => {
    const some = [...Array.from({ length: 19 }, () => done(600)), done(600, 1, ['wrong_key'])]
    expect(summariseHotkeyDrill(some, 2500).score).toBe(95)
    const many = [...Array.from({ length: 10 }, () => done(600)), done(600, 1, ['wrong_key', 'wrong_key', 'wrong_lots', 'wrong_key'])]
    const summary = summariseHotkeyDrill(many, 2500)
    expect(summary.score).toBe(60); expect(summary.stats).toMatchObject({ errors: 4, correct: 11, err_wrong_key: 3, err_wrong_lots: 1 })
  })
  it('missed prompts and ignored cues count as errors, a correct ignore as correct without a reaction time', () => {
    const summary = summariseHotkeyDrill([done(600), { id: 2, steps: 1, kind: 'missed', rtMs: 0, errors: ['missed'] }, { id: 3, steps: 1, kind: 'ignored', rtMs: 0, errors: ['ignored_cue'] }, { id: 4, steps: 1, kind: 'ignored', rtMs: 0, errors: [] }], 2500)
    expect(summary.stats).toMatchObject({ correct: 2, errors: 2, err_missed: 1, err_ignored_cue: 1, median_rt_ms: 600, longest_streak: 1 })
    expect(summary.stats!.error_rate).toBe(50)
  })
  it('empty and degenerate sessions score 0, the streak counts clean prompts, and every number is finite and the keys are valid', () => {
    expect(summariseHotkeyDrill([], 2500).score).toBe(0)
    const s = summariseHotkeyDrill([done(900), done(900), done(900, 1, ['wrong_key']), done(900), done(900)], 2500)
    expect(s.stats!.longest_streak).toBe(2)
    for (const [key, value] of Object.entries(s.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value)).toBe(true) }
    expect(Object.keys(s.stats!).length).toBeLessThanOrEqual(20); expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(100)
  })
})

describe('key map settings', () => {
  it('four different letters, falling back to the defaults and never colliding', () => {
    expect(normalizeKeys(undefined)).toEqual(DEFAULT_KEYS)
    expect(normalizeKeys({ buyCe: 'Q' }).buyCe).toBe('q')
    const clash = normalizeKeys({ buyCe: 'p', buyPe: 'p' }); expect(new Set(Object.values(clash)).size).toBe(4); expect(clash.buyCe).toBe('p')
    expect(normalizeKeys({ buyCe: '1', buyPe: 'ab', exitAll: 5 })).toEqual(DEFAULT_KEYS)
    const stolen = normalizeKeys({ buyCe: 's' }); expect(stolen.buyCe).toBe('s'); expect(new Set(Object.values(stolen)).size).toBe(4)
  })
  it('settings carry the keys and repair a bad map', () => {
    expect(normalizeSettings(undefined)).toMatchObject({ keyBuyCe: 'c', keyBuyPe: 'p', keyExitAll: 'x', keyStopCost: 's' })
    expect(normalizeSettings({ keyBuyCe: 'z', keyStopCost: 'z' })).toMatchObject({ keyBuyCe: 'z' })
    expect(new Set([DEFAULT_SETTINGS.keyBuyCe, DEFAULT_SETTINGS.keyBuyPe, DEFAULT_SETTINGS.keyExitAll, DEFAULT_SETTINGS.keyStopCost]).size).toBe(4)
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Speed; a session is three blocks; every parameter is finite at every level', () => {
    expect(isPlayable('hotkey_drill')).toBe(true)
    const game = getGame('hotkey_drill')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('speed'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    if (game.kind === 'market') expect(game.roundsPerSession(1)).toBe(HOTKEY_DRILL.blocks)
    for (let level = 1; level <= 20; level++) {
      const p = paramsAt(game.paramTable, level)
      for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${level} ${key}`).toBe(true)
      expect(p.gapMinMs).toBeLessThanOrEqual(p.gapMaxMs); expect(p.rtSlow).toBeGreaterThan(HOTKEY_DRILL.rtFastMs)
    }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ maxChain: 1, ignoreShare: 0, rtSlow: 2500 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ maxChain: 3, ignoreShare: 0.2, rtSlow: 1500 })
  })
  it('first paint shows the mock panel with the player\'s keys and nothing is sent anywhere', () => {
    const keys = { buyCe: 'q', buyPe: 'w', exitAll: 'e', stopCost: 'r' }
    const market = { data: {} as never, cost: { slippagePtsPerSide: 0.5, roundTripCostPerLotRs: 40, defaultLots: 1 }, keys, userId: 'u', today: '2026-11-16' }
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(HOTKEY_DRILL_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, market, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Mock order panel'); expect(html).toContain('<kbd>Q</kbd>'); expect(html).toContain('<kbd>R</kbd>'); expect(html).toContain('Block 1 of 3')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { ALL_GAME_IDS, BRAIN_GAME_IDS, CATALOGUE, CATEGORIES, MARKET_GAME_IDS, catalogueEntry, gamesIn, isGameId } from './ids'
import { createRng, hashSeed, sessionRng, sessionSeed } from './rng'
import { applyLevelRule, clampLevel, levelBand, paramsAt, valueAt, INITIAL_LEVEL_STATE, type ParamTable } from './difficulty'
import { categoryRatings, clamp, levelFactor, nextEma, ratedScore, toSessionScore } from './scoring'
import { clearRegistryForTests, getGame, isPlayable, registerGame, registeredIds } from './registry'
import type { AnyGameDefinition } from './types'
import { isTimedBlock } from './types'
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from './settings'
import { COUNTDOWN_FROM, initialShell, shellReducer, shouldRecord, type ShellEvent, type ShellState } from './shell'
import { localDate, newId } from './uid'
import { validGamesPath } from './paths'

describe('catalogue', () => {
  it('has the 31 ids: 10 market and 21 brain, three per category in the brain pool where the spec says so', () => {
    expect(ALL_GAME_IDS).toHaveLength(31)
    expect(MARKET_GAME_IDS).toHaveLength(10)
    expect(BRAIN_GAME_IDS).toHaveLength(21)
    expect(new Set(ALL_GAME_IDS).size).toBe(31)
    expect(CATALOGUE.map(entry => entry.id).sort()).toEqual([...ALL_GAME_IDS].sort())
    for (const category of ['speed', 'memory', 'attention', 'flexibility', 'math', 'reasoning', 'word'] as const) {
      expect(CATALOGUE.filter(entry => entry.pool === 'brain' && entry.category === category)).toHaveLength(3)
    }
    expect(CATEGORIES).toContain('discipline')
    expect(gamesIn('all')).toHaveLength(31)
    expect(gamesIn('brain')).toHaveLength(21)
    expect(catalogueEntry('quick_match').category).toBe('speed')
    expect(isGameId('tick_reader') && !isGameId('nope')).toBe(true)
  })

  it('matches the server whitelist (backend games_persistence_service)', () => {
    // Keep the two lists identical: this is the same set of 31 ids the backend accepts.
    expect([...ALL_GAME_IDS].sort().join(',')).toBe([
      'anagram_dash', 'card_sorter', 'code_breaker', 'colour_clash', 'entry_sniper', 'equation_drop', 'exit_discipline', 'flanker_flock', 'flip_map',
      'green_light', 'grid_recall', 'hotkey_drill', 'letter_grid', 'level_recall', 'make_target', 'n_back_stream', 'needle_finder', 'no_trade_day',
      'number_series', 'number_sprint', 'pattern_matrix', 'quick_match', 'regime_switch', 'risk_calculator', 'rule_switch', 'sequence_echo',
      'spot_the_trap', 'strike_picker', 'tick_reader', 'track_the_dots', 'word_ladder',
    ].join(','))
  })
})

describe('rng', () => {
  it('is deterministic for a seed and different for another', () => {
    const a = createRng(42), b = createRng(42), c = createRng(43)
    const seq = (r: ReturnType<typeof createRng>) => Array.from({ length: 8 }, () => r.next())
    expect(seq(a)).toEqual(seq(b))
    expect(seq(createRng(42))).not.toEqual(seq(c))
  })
  it('keeps floats in [0,1), ints inclusive, shuffle a permutation', () => {
    const r = createRng(7)
    for (let i = 0; i < 2000; i++) { const x = r.next(); expect(x >= 0 && x < 1).toBe(true) }
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) seen.add(r.int(3, 6))
    expect([...seen].sort()).toEqual([3, 4, 5, 6])
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    const shuffled = r.shuffle(items)
    expect(shuffled.slice().sort()).toEqual(items)
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('seeds a session from user, date, game and session number', () => {
    expect(sessionSeed('u', '2026-11-15', 'quick_match', 1)).toBe(sessionSeed('u', '2026-11-15', 'quick_match', 1))
    const base = sessionSeed('u', '2026-11-15', 'quick_match', 1)
    for (const other of [sessionSeed('v', '2026-11-15', 'quick_match', 1), sessionSeed('u', '2026-11-16', 'quick_match', 1), sessionSeed('u', '2026-11-15', 'colour_clash', 1), sessionSeed('u', '2026-11-15', 'quick_match', 2)]) expect(other).not.toBe(base)
    expect(sessionRng('u', 'd', 'g', 1).next()).toBe(sessionRng('u', 'd', 'g', 1).next())
    expect(hashSeed('')).toBeGreaterThanOrEqual(0)
    // Pinned value: changing the hash would change every replayable session.
    expect(hashSeed('tradematangi')).toBe(hashSeed('tradematangi'))
  })
  it('pinned mulberry32 output (guards against accidental algorithm changes)', () => {
    const r = createRng(1)
    expect([r.next(), r.next(), r.next()].map(x => Math.round(x * 1e6))).toEqual([627074, 2736, 527447])
  })
})

describe('difficulty', () => {
  const table: ParamTable = {
    span: { anchors: [3, 4, 6, 8, 10], integer: true },
    flash: { anchors: [700, 600, 500, 400, 300] },
    kind: { steps: [{ from: 1, v: 0 }, { from: 6, v: 1 }, { from: 13, v: 2 }] },
  }
  it('hits the anchors exactly and interpolates between them', () => {
    expect([1, 5, 10, 15, 20].map(l => valueAt(table.span, l))).toEqual([3, 4, 6, 8, 10])
    expect(valueAt(table.flash, 3)).toBe(650)
    expect(valueAt(table.flash, 7)).toBe(560)
    expect(valueAt(table.span, 3)).toBe(4) // 3.5 rounds
  })
  it('steps change exactly at their level', () => {
    expect([1, 5, 6, 12, 13, 20].map(l => valueAt(table.kind, l))).toEqual([0, 0, 1, 1, 2, 2])
  })
  it('clamps levels and tolerates odd input', () => {
    expect(clampLevel(0)).toBe(1); expect(clampLevel(99)).toBe(20); expect(clampLevel(NaN)).toBe(1); expect(clampLevel(7.6)).toBe(8)
    expect(valueAt(table.flash, -5)).toBe(700); expect(valueAt(table.flash, 50)).toBe(300)
    expect(paramsAt(table, 10)).toEqual({ span: 6, flash: 500, kind: 1 })
    expect(() => valueAt({ steps: [] }, 1)).toThrow()
  })
  it('bands', () => { expect([1, 5, 6, 10, 11, 15, 16, 20].map(levelBand)).toEqual(['Warm-up', 'Warm-up', 'Trader', 'Trader', 'Pro', 'Pro', 'Elite', 'Elite']) })

  it('levels up after two high scores in a row, down after two low, one change per session', () => {
    let s = { ...INITIAL_LEVEL_STATE, level: 5 }
    s = { ...s, ...applyLevelRule(s, 80) }; expect(s.level).toBe(5)
    const up = applyLevelRule(s, 71); expect(up.level).toBe(6); expect(up.change).toBe(1); expect(up.consecutiveHigh).toBe(0)
    let d = { level: 5, consecutiveHigh: 0, consecutiveLow: 0 }
    d = { ...d, ...applyLevelRule(d, 40) }; expect(d.level).toBe(5)
    expect(applyLevelRule(d, 10).level).toBe(4)
  })
  it('a mid score resets both streaks; thresholds are inclusive; never below 1 or above 20', () => {
    const mid = applyLevelRule({ level: 5, consecutiveHigh: 1, consecutiveLow: 1 }, 55)
    expect(mid).toMatchObject({ level: 5, consecutiveHigh: 0, consecutiveLow: 0, change: 0 })
    expect(applyLevelRule({ level: 5, consecutiveHigh: 1, consecutiveLow: 0 }, 70).level).toBe(6)
    expect(applyLevelRule({ level: 1, consecutiveHigh: 0, consecutiveLow: 1 }, 0)).toMatchObject({ level: 1, change: 0 })
    expect(applyLevelRule({ level: 20, consecutiveHigh: 1, consecutiveLow: 0 }, 100)).toMatchObject({ level: 20, change: 0 })
  })
})

describe('scoring', () => {
  it('clamps and rounds a session score, NaN is 0', () => {
    expect([toSessionScore(55.5), toSessionScore(-3), toSessionScore(140), toSessionScore(NaN), toSessionScore(Infinity)]).toEqual([56, 0, 0, 0, 0].map((v, i) => (i === 2 ? 100 : v)))
    expect(clamp(5, 1, 3)).toBe(3)
  })
  it('level factor and moving score', () => {
    expect(levelFactor(1)).toBeCloseTo(0.62); expect(levelFactor(20)).toBe(1); expect(levelFactor(99)).toBe(1)
    expect(ratedScore(80, 10)).toBeCloseTo(64)
    expect(nextEma(undefined, 60)).toBe(60)
    expect(nextEma(50, 80)).toBe(59)
  })
  it('category rating is the mean of played games and omits unplayed categories', () => {
    expect(categoryRatings([{ id: 'quick_match', emaScore: 60 }, { id: 'colour_clash', emaScore: 80 }, { id: 'tick_reader', emaScore: 50 }, { id: 'green_light' }]))
      .toEqual({ speed: 63.3 })
    expect(categoryRatings([{ id: 'grid_recall', emaScore: 40 }])).toEqual({ memory: 40 })
    expect(categoryRatings([])).toEqual({})
  })
})

const fake = (id: AnyGameDefinition['id'], over: Partial<AnyGameDefinition> = {}): AnyGameDefinition => ({
  id, kind: catalogueEntry(id).pool === 'market' ? 'market' : 'trial', category: catalogueEntry(id).category, title: 't', blurb: 'b', instructions: ['one'], paramTable: {},
  View: () => null,
  ...(catalogueEntry(id).pool === 'market' ? { roundsPerSession: () => 5 } : { session: { kind: 'timed', seconds: 60 } }),
  ...over,
} as AnyGameDefinition)

describe('registry', () => {
  afterEach(clearRegistryForTests)
  it('registers a game once and rejects bad registrations', () => {
    registerGame(fake('quick_match'))
    expect(isPlayable('quick_match') && !isPlayable('colour_clash')).toBe(true)
    expect(registeredIds()).toEqual(['quick_match']); expect(getGame('quick_match')?.title).toBe('t')
    expect(() => registerGame(fake('quick_match'))).toThrow(/already/)
    expect(() => registerGame(fake('colour_clash', { id: 'nope' as never }))).toThrow(/Unknown game id/)
    expect(() => registerGame(fake('tick_reader', { kind: 'trial', session: { kind: 'timed', seconds: 1 } } as never))).toThrow(/kind market/)
    expect(() => registerGame(fake('green_light', { category: 'math' }))).toThrow(/category speed/)
    expect(() => registerGame(fake('grid_recall', { instructions: Array(7).fill('x') }))).toThrow(/6 instruction/)
  })
  it('timed trial games are timed blocks; rounds and market games are not', () => {
    expect(isTimedBlock(fake('quick_match'))).toBe(true)
    expect(isTimedBlock(fake('grid_recall', { session: { kind: 'rounds', count: () => 5 } } as never))).toBe(false)
    expect(isTimedBlock(fake('tick_reader'))).toBe(false)
  })
})

describe('settings', () => {
  it('falls back to defaults and clamps', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ sound: true, zoom: 500, warmupPool: 'brain', reduceMotion: 1 })).toEqual({ ...DEFAULT_SETTINGS, sound: true, zoom: 150, warmupPool: 'brain' })
    expect(normalizeSettings({ zoom: 10, warmupPool: 'nope' })).toMatchObject({ zoom: 80, warmupPool: 'both' })
    expect(normalizeSettings({ zoom: 'big' }).zoom).toBe(100)
  })
  it('keeps unknown keys that another version stored', () => {
    expect(mergeSettings({ future: 1, sound: true }, { ...DEFAULT_SETTINGS })).toMatchObject({ future: 1, sound: false, zoom: 100 })
  })
})

describe('session shell', () => {
  const run = (state: ShellState, ...events: ShellEvent[]) => events.reduce(shellReducer, state)
  const start = (timed: boolean) => run(initialShell(timed, 4), { type: 'start', mode: 'progress', level: 4 })

  it('goes instructions -> countdown 3-2-1 -> playing -> result and records a finished session', () => {
    let s = start(true)
    expect(s.phase).toBe('countdown'); expect(s.countdown).toBe(COUNTDOWN_FROM)
    s = run(s, { type: 'tick' }, { type: 'tick' }); expect(s.phase).toBe('countdown'); expect(s.countdown).toBe(1)
    s = run(s, { type: 'tick' }); expect(s.phase).toBe('playing')
    s = run(s, { type: 'finish', summary: { score: 77 } })
    expect(s.phase).toBe('result'); expect(shouldRecord(s)).toBe(true); expect(s.summary?.score).toBe(77)
  })
  it('cannot pause a timed block but can pause a round-based game', () => {
    const playing = (timed: boolean) => run(start(timed), { type: 'tick' }, { type: 'tick' }, { type: 'tick' })
    expect(shellReducer(playing(true), { type: 'pause' }).phase).toBe('playing')
    const paused = shellReducer(playing(false), { type: 'pause' }); expect(paused.phase).toBe('paused')
    expect(shellReducer(paused, { type: 'resume' }).phase).toBe('playing')
  })
  it('quit asks first, can be cancelled, and records nothing', () => {
    let s = run(start(true), { type: 'tick' }, { type: 'tick' }, { type: 'tick' })
    s = run(s, { type: 'requestQuit' }); expect(s.quitFrom).toBe('playing')
    s = run(s, { type: 'cancelQuit' }); expect(s.quitFrom).toBeNull(); expect(s.phase).toBe('playing')
    s = run(s, { type: 'requestQuit' }, { type: 'confirmQuit' }); expect(s.phase).toBe('closed'); expect(shouldRecord(s)).toBe(false)
  })
  it('the countdown does not run while the quit dialog is open', () => {
    const s = run(start(true), { type: 'requestQuit' })
    expect(shellReducer(s, { type: 'tick' }).countdown).toBe(COUNTDOWN_FROM)
  })
  it('a void (focus lost, data failed) records nothing and can be retried', () => {
    let s = run(start(true), { type: 'tick' }, { type: 'tick' }, { type: 'tick' }, { type: 'void', reason: 'away' })
    expect(s.phase).toBe('voided'); expect(shouldRecord(s)).toBe(false); expect(s.voidReason).toBe('away')
    s = run(s, { type: 'again' }); expect(s.phase).toBe('instructions')
  })
  it('ignores events in the wrong phase', () => {
    const s = initialShell(true)
    expect(shellReducer(s, { type: 'finish', summary: { score: 5 } })).toBe(s)
    expect(shellReducer(s, { type: 'tick' })).toBe(s)
    expect(shellReducer(s, { type: 'confirmQuit' })).toBe(s)
    expect(shouldRecord(s)).toBe(false)
  })
})

describe('helpers', () => {
  it('ids are 8-64 characters and unique; dates are local YYYY-MM-DD', () => {
    const a = newId(), b = newId()
    expect(a).not.toBe(b); expect(a.length >= 8 && a.length <= 64).toBe(true)
    expect(localDate(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05')
    expect(localDate(new Date(2026, 0, 1))).toBe('2026-01-01')
  })
  it('only the three Games routes, GET and PUT, are allowed', () => {
    expect(validGamesPath('state', 'GET') && validGamesPath('state', 'PUT') && validGamesPath('availability', 'GET') && validGamesPath('window?symbol=NIFTY', 'GET')).toBe(true)
    for (const [m, p] of [['POST', 'state'], ['DELETE', 'state'], ['PUT', 'window'], ['GET', '/state'], ['GET', '../x'], ['GET', 'state/x'], ['GET', 'st%61te'], ['get', 'state'], ['GET', 'orders'], ['GET', '']]) expect(validGamesPath(p, m)).toBe(false)
  })
})

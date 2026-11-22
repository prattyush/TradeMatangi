import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReviewTab } from '../ui/ReviewTab'
import { breakoutRow, exitRow, huntRow, levelRow, pickRow, promptRow, questionRow, regimeRow, segmentRow, sniperRow, tickRow, where } from './review'

const here = dirname(fileURLToPath(import.meta.url))
const as = <T,>(value: unknown): T => value as T

describe('where', () => {
  it('is market, day and the clock time of the second of the day', () => {
    expect(where('NIFTY', '2026-10-21', 38_445)).toBe('NIFTY 2026-10-21 10:40:45'); expect(where('BSESEN', '2026-09-03', 33_300)).toBe('BSESEN 2026-09-03 09:15:00')
  })
})

describe('round rows', () => {
  const t = as<never>({ symbol: 'NIFTY', date: '2026-10-21', decisionSec: 38_445, move: 6.25, edge: true })
  it('Tick Reader: a profitable trade is right, a loss is wrong, a skip is right only when there was no edge', () => {
    expect(tickRow(1, t, as({ answer: 'long', kind: 'trade', net: 2.5, decisionMs: 3100 }))).toEqual({ n: 1, shown: 'NIFTY 2026-10-21 10:40:45', answered: 'Long, +2.50 pts', correctAnswer: 'a tradable move (+6.25 pts)', correct: true, rtMs: 3100 })
    expect(tickRow(2, t, as({ answer: 'short', kind: 'trade', net: -1.2, decisionMs: 900 })).correct).toBe(false)
    expect(tickRow(3, t, as({ answer: 'skip', kind: 'missed_move', net: 0, decisionMs: 1000 })).correct).toBe(false)
    const quiet = as<never>({ symbol: 'NIFTY', date: 'd', decisionSec: 36_000, move: 0.4, edge: false })
    expect(tickRow(4, quiet, as({ answer: 'skip', kind: 'correct_skip', net: 0, decisionMs: 700 }))).toMatchObject({ answered: 'Skip', correctAnswer: 'skip (move +0.40 pts)', correct: true })
    expect(tickRow(5, quiet, as({ answer: 'timeout', kind: 'timeout_skip', net: 0, decisionMs: 8000 }))).toMatchObject({ answered: 'Timed out', correct: false })
  })
  it('Entry Sniper and Exit Discipline say what happened against the best', () => {
    const s = as<never>({ symbol: 'NIFTY', date: 'd', startSec: 40_000 })
    expect(sniperRow(1, s, as({ kind: 'enter', offset: 12, userR: 0.8, bestR: 1.4, bestOffset: 7, roundScore: 0.62 }))).toMatchObject({ answered: 'entered at +12 s, +0.80 R', correctAnswer: 'entry at +7 s, +1.40 R', correct: true })
    expect(sniperRow(2, s, as({ kind: 'pass', offset: null, userR: 0, bestR: 0, bestOffset: null, roundScore: 1 }))).toMatchObject({ answered: 'passed', correctAnswer: 'no good entry (pass)' })
    expect(sniperRow(3, s, as({ kind: 'timeout', offset: null, userR: 0, bestR: 1, bestOffset: 3, roundScore: 0 }))).toMatchObject({ answered: 'timed out', correct: false })
    const e = as<never>({ symbol: 'BSESEN', date: 'd', startSec: 41_000 })
    expect(exitRow(1, e, as({ outcome: 'target', userR: 1.5, planR: 1.5, mfeR: 2.2, capture: 0.68, overrides: 0 }))).toMatchObject({ answered: 'target, +1.50 R', correctAnswer: 'plan +1.50 R, best available +2.20 R', correct: true })
    expect(exitRow(2, e, as({ outcome: 'stop', userR: -1, planR: 1, mfeR: 1.2, capture: 0, overrides: 2 }))).toMatchObject({ answered: 'stop, −1.00 R, 2 overrides', correct: false })
  })
  it('Level Recall, Strike Picker, Regime Switch, Risk Calculator and Hotkey Drill', () => {
    const l = as<never>({ symbol: 'NIFTY', date: 'd', roundSec: 40_000 })
    expect(levelRow(1, l, as({ mode: 'levels', roundScore: 0.7, errors: [{ errorUnits: 0.5 }, { errorUnits: 1.5 }, { errorUnits: null }], sequence: undefined }))).toMatchObject({ shown: 'NIFTY d 11:06:40, 3 levels', answered: '2 placed, mean error 1.00 units', correct: true })
    expect(levelRow(2, l, as({ mode: 'sequence', roundScore: 0.6, errors: [], sequence: { correct: 4, total: 5 } }))).toMatchObject({ answered: '4 of 5 right', correct: false })
    const sc = as<never>({ symbol: 'NIFTY', right: 'PE', dte: 1, minutes: 15, objective: 'capital_pnl' })
    expect(pickRow(1, sc, as({ offset: -2, roundScore: 0.82, driver: 'delta' }))).toEqual({ n: 1, shown: 'NIFTY put, 1 day to expiry, 15 min, capital pnl', answered: 'strike -2', correctAnswer: 'score 82%, led by delta', correct: true, rtMs: null })
    expect(pickRow(2, sc, as({ offset: null, roundScore: 0, driver: 'theta' })).answered).toBe('timed out')
    const seg = as<never>({ round: { symbol: 'NIFTY', date: 'd', decisionSec: 36_000 } })
    expect(regimeRow(1, seg, as({ regime: 'trend_up', playbook: 'follow', best: 'follow', correct: true, perseveration: false }))).toMatchObject({ shown: 'NIFTY d 10:00:00, trend up', answered: 'FOLLOW', correctAnswer: 'FOLLOW', correct: true })
    expect(regimeRow(2, seg, as({ regime: 'range', playbook: 'timeout', best: 'fade', correct: false, perseveration: true }))).toMatchObject({ answered: 'timed out', correctAnswer: 'FADE (old playbook kept)' })
    expect(questionRow(1, as({ prompt: 'Risk of 2 lots?', answer: 1605, unit: '₹' }), as({ entered: 1600, verdict: 'close', timeMs: 4200 }))).toEqual({ n: 1, shown: 'Risk of 2 lots?', answered: '1600', correctAnswer: '1605 ₹', correct: false, rtMs: 4200 })
    expect(questionRow(2, as({ prompt: 'q', answer: 5, unit: '' }), as({ entered: null, verdict: 'timeout', timeMs: 9000 }))).toMatchObject({ answered: 'no answer', correctAnswer: '5' })
    expect(promptRow(1, as({ steps: 3, kind: 'done', rtMs: 1800, errors: [] }))).toMatchObject({ shown: '3-step prompt', answered: 'done', correct: true, rtMs: 1800 })
    expect(promptRow(2, as({ steps: 1, kind: 'done', rtMs: 900, errors: ['wrong_key'] }))).toMatchObject({ answered: 'done, 1 error', correct: false })
    expect(promptRow(3, as({ steps: 2, kind: 'missed', rtMs: 0, errors: [] }))).toMatchObject({ answered: 'missed', rtMs: null, correct: false })
  })
  it('Spot the Trap and No-Trade Day', () => {
    const b = as<never>({ symbol: 'NIFTY', date: 'd', breakoutSec: 45_000, direction: -1, real: true })
    expect(breakoutRow(1, b, as({ verdict: 'fake', correct: false }))).toEqual({ n: 1, shown: 'NIFTY d 12:30:00, breakout down', answered: 'FAKE', correctAnswer: 'REAL', correct: false, rtMs: null })
    expect(breakoutRow(2, b, as({ verdict: 'timeout', correct: false })).answered).toBe('timed out')
    const h = as<never>({ symbol: 'NIFTY', date: 'd', startSec: 40_000, pattern: 'pin_bar' })
    expect(huntRow(1, h, as({ clicks: 3, recall: 1, precision: 0.5, truth: 1, roundScore: 0.67 }))).toMatchObject({ shown: 'NIFTY d 11:06:40, Pin-bar rejection', answered: '3 clicks, 100% found, 50% right', correctAnswer: '1 occurrence', correct: true })
    expect(segmentRow(1, { symbol: 'NIFTY', date: 'd', startSec: 36_000 }, as({ netR: -1.09, tradeCount: 3, violations: 1, revenge: 2, opportunity: 8.54, roundScore: 0.34 }))).toMatchObject({ answered: '−1.09 R in 3 trades, 1 rule break, 2 revenge', correctAnswer: 'best in hindsight +8.54 R', correct: false })
  })
})

describe('every market game keeps a round log', () => {
  it('each market View hands its rows to onFinish', () => {
    const dir = join(here, 'games'); const names = readdirSync(dir).filter(name => !name.includes('.'))
    expect(names.length).toBe(10)
    for (const name of names) expect(readFileSync(join(dir, name, 'View.tsx'), 'utf8'), name).toMatch(/review: /)
  })
})

describe('Review lists market sessions without a replay', () => {
  const session = (gameId: string) => ({ id: gameId, gameId, date: '2026-11-16', level: 3, mode: 'progress' as const, seed: 1, score: 70, playedAt: '2026-11-16T10:00:00Z', stats: { rounds: 1 }, review: [{ n: 1, shown: 'NIFTY d 10:00:00', answered: 'Long', correctAnswer: 'skip', correct: false, rtMs: 900 }] })
  it('a market session shows its rounds and a note, a brain session still has the replay button', () => {
    const html = renderToStaticMarkup(createElement(ReviewTab, { sessions: [session('tick_reader')], renderReplay: () => null, initialOpenId: 'tick_reader' }))
    expect(html).toContain('NIFTY d 10:00:00'); expect(html).toContain('not replayed'); expect(html).not.toContain('Play these puzzles again')
    const brain = renderToStaticMarkup(createElement(ReviewTab, { sessions: [session('quick_match')], renderReplay: () => null, initialOpenId: 'quick_match' }))
    expect(brain).toContain('Play these puzzles again'); expect(brain).not.toContain('not replayed')
  })
})

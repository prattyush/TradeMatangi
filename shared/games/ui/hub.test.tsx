import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_STATE, type ProgressState } from '../core/progress'
import type { LocalSession } from '../core/dashboard'
import { DEFAULT_SETTINGS, normalizeSettings } from '../core/settings'
import { paramsAt } from '../core/difficulty'
import { getGame } from '../core/registry'
import { applyPalette, PALETTE, paletteHex } from '../brain/ui/palette'
import '../games'
import { Dashboard } from './Dashboard'
import { ReviewTab } from './ReviewTab'
import { SettingsPanel } from './SettingsPanel'
import { Sparkline } from './Sparkline'

const state: ProgressState = {
  ...EMPTY_STATE,
  games: { colour_clash: { revision: 2, level: 3, sessions: 4, best: 88, emaScore: 61, lastScores: [40, 55, 70, 88], stats: { stroop_effect: 120 } } },
  days: { '2026-11-15': { revision: 1, warmupDone: 5 }, '2026-11-16': { revision: 1, warmupDone: 2 } },
}
const session = (i: number): LocalSession => ({ id: `s${i}`, gameId: 'colour_clash', date: '2026-11-16', level: 3, mode: 'progress', seed: 99, score: 60 + i, stats: { stroop_effect: 130 - i * 10 }, playedAt: `2026-11-16T10:0${i}:00Z`, review: [{ n: 1, shown: 'RED in blue ink', answered: 'BLUE', correctAnswer: 'BLUE', correct: true, rtMs: 512 }] })

describe('Dashboard', () => {
  const html = renderToStaticMarkup(<Dashboard state={state} sessions={[1, 2, 3, 4].map(session)} today="2026-11-16" />)
  it('shows the streak, category ratings, the game table and the brain trend panels', () => {
    expect(html).toContain('Warm-up streak')
    expect(html).toContain('1 day')
    expect(html).toContain('today: 2 of 5 steps')
    expect(html).toContain('Speed')
    expect(html).toContain('Colour Clash')
    expect(html).toContain('L3')
    expect(html).toContain('Colour interference')
    expect(html).toContain('90 ms')
    expect(html).toContain('improving')
  })
  it('shows one table row per game in All, and no game is marked coming soon now that all are playable', () => {
    expect(html).not.toContain('coming soon')
    expect((html.match(/<tr /g) ?? []).length).toBe(31)
  })
  it('gives charts and meters a name for screen readers', () => {
    expect(html).toMatch(/role="img" aria-label="Colour Clash: last 4 scores/)
    expect(html).toMatch(/<meter[^>]*aria-labelledby="rate-speed"/)
    expect(html).toContain('<caption class="games-sr">')
  })
  it('an empty state still renders without errors', () => {
    const empty = renderToStaticMarkup(<Dashboard state={EMPTY_STATE} sessions={[]} today="2026-11-16" />)
    expect(empty).toContain('Play a game in Progress mode')
    expect(empty).toContain('no data yet')
  })
})

describe('Sparkline', () => {
  it('draws one point as a dot, many as a line, none as a note', () => {
    expect(renderToStaticMarkup(<Sparkline values={[5]} label="x" />)).toContain('<circle')
    expect(renderToStaticMarkup(<Sparkline values={[1, 2, 3]} label="x" />)).toContain('<polyline')
    expect(renderToStaticMarkup(<Sparkline values={[]} label="x" />)).toContain('no data yet')
  })
  it('keeps every point inside the box even when a value is outside the fixed range', () => {
    const html = renderToStaticMarkup(<Sparkline values={[-50, 200, 50]} min={0} max={100} width={100} height={30} label="x" />)
    const ys = [...html.matchAll(/(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g)].map(match => Number(match[2]))
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0); expect(Math.max(...ys)).toBeLessThanOrEqual(30)
  })
})

describe('Review tab', () => {
  it('lists sessions that have trials, newest first, and says when there are none', () => {
    const html = renderToStaticMarkup(<ReviewTab sessions={[session(1), session(2), { ...session(3), review: undefined }]} renderReplay={() => null} />)
    expect(html).toContain('Colour Clash')
    expect(html).toContain('score 62')
    expect(html.indexOf('score 62')).toBeLessThan(html.indexOf('score 61'))
    expect(html).not.toContain('score 63')
    expect(renderToStaticMarkup(<ReviewTab sessions={[]} renderReplay={() => null} />)).toContain('Play a game and its trials appear here')
  })
})

describe('Settings', () => {
  it('offers palette, reduce motion, zoom, sound, warm-up pool and the practice-tool note', () => {
    const html = renderToStaticMarkup(<SettingsPanel settings={DEFAULT_SETTINGS} disabled={false} onSave={async () => undefined} />)
    for (const text of ['Reduce motion', 'Colour-blind safe', 'Higher contrast', 'Sound', 'Warm-up games', 'not a medical product']) expect(html).toContain(text)
    expect(html).toContain('<fieldset>')
  })
  it('normalises the palette and keeps older saved settings working', () => {
    expect(normalizeSettings({ palette: 'contrast' }).palette).toBe('contrast')
    expect(normalizeSettings({ palette: 'neon' }).palette).toBe('safe')
    expect(normalizeSettings({ sound: true, zoom: 120 })).toMatchObject({ palette: 'safe', sound: true, zoom: 120 })
  })
})

describe('palette', () => {
  it('switches the six hues and back, never touching names or patterns', () => {
    const names = PALETTE.map(colour => colour.name), patterns = PALETTE.map(colour => colour.pattern)
    applyPalette('contrast')
    expect(PALETTE.map(colour => colour.hex)).toEqual([...paletteHex('contrast')])
    applyPalette('safe')
    expect(PALETTE.map(colour => colour.hex)).toEqual([...paletteHex('safe')])
    expect(PALETTE.map(colour => colour.name)).toEqual(names); expect(PALETTE.map(colour => colour.pattern)).toEqual(patterns)
    expect(new Set(paletteHex('contrast')).size).toBe(6); expect(new Set(paletteHex('safe')).size).toBe(6)
  })
})

describe('reduce motion', () => {
  it('slows Track the Dots and Equation Drop and leaves every other game alone', () => {
    const dots = getGame('track_the_dots')!, drop = getGame('equation_drop')!
    for (const level of [1, 10, 20]) {
      const base = paramsAt(dots.paramTable, level), slow = dots.reducedMotionParams!(base)
      expect(slow.speed).toBeLessThan(base.speed); expect(slow.dots).toBe(base.dots)
      const dropBase = paramsAt(drop.paramTable, level), dropSlow = drop.reducedMotionParams!(dropBase)
      expect(dropSlow.fallStartMs).toBeGreaterThan(dropBase.fallStartMs); expect(dropSlow.fallEndMs).toBeGreaterThan(dropBase.fallEndMs)
    }
    const withHook = ['track_the_dots', 'equation_drop']
    for (const id of ['quick_match', 'grid_recall', 'letter_grid', 'word_ladder'] as const) expect(getGame(id)!.reducedMotionParams).toBeUndefined()
    expect(withHook.every(id => getGame(id as 'track_the_dots')!.reducedMotionParams)).toBe(true)
  })
})

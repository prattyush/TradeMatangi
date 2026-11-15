import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { dayTone, SessionDayButton, signedMoney, winText } from './SessionDayButton'

const group = (totalPnl: number) => ({
  key: 'k', date: '2026-11-09', symbol: 'NIFTY', instrument_type: 'options', session_type: 'sim', sessionCapital: 100000, totalPnl, totalTrades: 4,
  sessions: [{ session_id: 's1' }],
}) as unknown as Parameters<typeof SessionDayButton>[0]['group']

describe('Analysis day colours', () => {
  it('a winning day is green, a losing day red, a flat day neutral', () => {
    expect(dayTone(1200)).toBe('win')
    expect(dayTone(-0.5)).toBe('loss')
    expect(dayTone(0)).toBe('flat')
  })

  it('shows the P&L with a sign', () => {
    expect(signedMoney(1234.5)).toBe('+₹1,234.5')
    expect(signedMoney(-850)).toBe('−₹850')
    expect(signedMoney(0)).toBe('₹0')
  })

  it('marks the button and its P&L so the stylesheet can colour them, and keeps the pressed state', () => {
    const win = renderToStaticMarkup(<SessionDayButton group={group(1500)} pressed={false} onSelect={() => undefined} />)
    expect(win).toContain('analysis-day day-win')
    expect(win).toContain('day-pnl win')
    expect(win).toContain('+₹1,500')
    const loss = renderToStaticMarkup(<SessionDayButton group={group(-300)} pressed onSelect={() => undefined} />)
    expect(loss).toContain('analysis-day day-loss')
    expect(loss).toContain('aria-pressed="true"')
    expect(loss).toContain('−₹300')
    expect(loss).toContain('Replay')
  })
})

describe('Analysis day win percentage and badge', () => {
  it('shows the share of winning round trips, and nothing when unknown or when there are none', () => {
    expect(winText({ winningTrades: 3, totalTrades: 5 })).toBe(' · 60% wins')
    expect(winText({ winningTrades: 1, totalTrades: 3 })).toBe(' · 33% wins')
    expect(winText({ winningTrades: undefined, totalTrades: 5 })).toBe('')
    expect(winText({ winningTrades: 0, totalTrades: 0 })).toBe('')
    expect(winText({ winningTrades: 0, totalTrades: 4 })).toBe(' · 0% wins')
  })
  it('puts the win percentage and the labelled mark in the day button', () => {
    const base = group(100)
    const html = renderToStaticMarkup(<SessionDayButton group={{ ...base, winningTrades: 3, totalTrades: 4 }} pressed={false} onSelect={() => undefined} badge={<span className="tl-day-badge">3/4 labelled</span>} />)
    expect(html).toContain('4 closed trades · 75% wins')
    expect(html).toContain('3/4 labelled')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DiveCalendar from './DiveCalendar'
import type { DayMarks } from '../../../../shared/deepdive/model'

const noop = () => undefined

describe('DiveCalendar', () => {
  const marks = new Map<string, DayMarks>([['2026-10-06', { buy: true, sell: false }], ['2026-10-07', { buy: true, sell: true }]])
  const html = renderToStaticMarkup(<DiveCalendar month={{ year: 2026, month: 10 }} onMonthChange={noop} today="2026-10-12" marks={marks}
    selected="2026-10-07" onSelect={noop} onToggle={noop} />)

  it('shows the month, the weekday headers and a B and S button per pickable day', () => {
    expect(html).toContain('October 2026')
    for (const day of ['Mon', 'Tue', 'Fri', 'Sun']) expect(html).toContain(day)
    expect(html.match(/title="Buy setup on this day"/g)).toHaveLength(7) // weekdays 1-9 Oct minus weekends: 1,2,5,6,7,8,9
    expect(html).toContain('aria-label="2026-10-06, Buy setup"')
    expect(html).toContain('aria-label="2026-10-07, Buy setup, Sell setup"')
  })

  it('has no marking buttons on weekends, today or later days', () => {
    const cellOf = (date: string) => html.split('<div class="dd-cal-cell').find(part => part.includes(`aria-label="${date}`)) ?? ''
    for (const date of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) {
      expect(cellOf(date), date).toContain('disabled')
      expect(cellOf(date), date).not.toContain('dd-cal-sides')
    }
    expect(cellOf('2026-10-09')).toContain('dd-cal-sides')
  })

  it('locks the buttons for a shared deep dive', () => {
    const locked = renderToStaticMarkup(<DiveCalendar month={{ year: 2026, month: 10 }} onMonthChange={noop} today="2026-10-12" marks={marks}
      selected={null} onSelect={noop} onToggle={noop} readOnly />)
    expect(locked.match(/class="dd-side (buy|sell)"[^>]*disabled/g)).toHaveLength(14)
  })
})

describe('DiveHome (initial render)', () => {
  it('offers the start form and says the list is loading', async () => {
    vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
    const { default: DiveHome } = await import('./DiveHome')
    const client = { deepDive: {}, listCategories: vi.fn(), listStrategies: vi.fn(), addCategory: vi.fn(), addStrategy: vi.fn() } as never
    const html = renderToStaticMarkup(<DiveHome client={client} loading={false} error={null} onOpen={noop} />)
    expect(html).toContain('Start a deep dive')
    expect(html).toContain('Start deep dive')
    expect(html).toContain('Loading…')
    expect(html).toMatch(/<button class="pl-primary" disabled=""/)
  })
})

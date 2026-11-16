import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { toDiveSetup, withSetups } from '../../../../shared/deepdive/model'
import type { DeepDiveSetup, DeepDiveTag, Dive } from '../../../../shared/deepdive/types'
import Results from '../../../../shared/deepdive/ui/Results'
import { WithHost } from './testHost'

const tag = (id: string, name: string, status: 'active' | 'archived' = 'active'): DeepDiveTag => ({ tag_id: id, name, status, sort_order: 0, created_at: '', archived_at: null })
const day = (date: string, side: 'buy' | 'sell', tag_values: Record<string, boolean>, extra: Partial<DeepDiveSetup> = {}): DeepDiveSetup => ({
  category: 'Breakout', strategy: 'ORB', symbol: 'NIFTY', date, side, strike_ce: null, strike_pe: null, strike_mode: null, interval_minutes: 3,
  annotations: [], outcome: null, tag_values, notes: '', created_at: '', updated_at: '', ...extra,
})
const mark = { id: 'a', time: 1, price: 1, type: 'entry', instrument: 'underlying', strategy_name: 'ORB', category: 'Breakout', text: '' }
const tags = [tag('t1', 'Second leg'), tag('t2', 'Double top'), tag('old', 'Retired', 'archived')]
const build = (setups: DeepDiveSetup[], can_edit = true): Dive => withSetups({
  category: 'Breakout', strategy: 'ORB', owner_id: 'u', can_edit, setups: [], tags, incomplete_days: 0, unmarked_total: 0,
}, setups.map(s => toDiveSetup(s, tags)))
const render = (dive: Dive) => renderToStaticMarkup(<WithHost><Results dive={dive} onOpenDay={() => undefined} /></WithHost>)

describe('Results', () => {
  const dive = build([
    day('2026-10-06', 'buy', { t1: true, t2: false }, { outcome: 'success', annotations: [mark], notes: 'clean break' }),
    day('2026-10-07', 'buy', { t1: true }, { outcome: 'failed' }),
    day('2026-10-08', 'sell', { t1: false, t2: true }),
  ])

  it('shows each tag with its percentage, n and counts, and leaves archived tags out', () => {
    const html = render(dive)
    expect(html).toContain('Second leg')
    expect(html).toContain('66.7%')
    expect(html).toContain('(n=3)')
    expect(html).toContain('2 valid · 1 not valid')
    expect(html).toContain('Double top')
    expect(html).toContain('50%') // Double top: 1 valid of 2 marked
    expect(html).not.toContain('Retired')
    expect(html).toContain('Only 3 days marked')
  })

  it('shows the day count, the success rate and one row per day with its dots', () => {
    const html = render(dive)
    expect(html).toContain('3 days')
    expect(html).toContain('2 buy · 1 sell')
    expect(html).toContain('Success 1 of 2 (50%)')
    expect(html).toContain('6 Oct 2026')
    expect(html.match(/<tr>/g)).toHaveLength(1 + 3) // header + days
    expect(html.match(/dd-dot valid/g)).toHaveLength(3)
    expect(html.match(/dd-dot not_valid/g)).toHaveLength(2)
    expect(html).toContain('clean break')
  })

  it('offers Save to Patterns only for days with chart marks, and the bulk button counts them', () => {
    const html = render(dive)
    expect(html.match(/Save to Patterns/g)).toHaveLength(1)
    expect(html).toContain('Save 1 marked day to Pattern Library')
  })

  it('has Buy, Sell and All filters with their counts', () => {
    const html = render(dive)
    expect(html).toContain('All (3)')
    expect(html).toContain('Buy (2)')
    expect(html).toContain('Sell (1)')
    expect(html).toContain('Buy setups: long / bullish')
    expect(html).toContain('PE bought, CE sold')
  })

  it('hides the save controls on a shared deep dive', () => {
    const html = render(build([day('2026-10-06', 'buy', { t1: true }, { annotations: [mark] })], false))
    expect(html).not.toContain('Save to Patterns')
    expect(html).not.toContain('Pattern Library')
  })

  it('explains an empty dive and a dive with no tags', () => {
    expect(render(build([]))).toContain('nothing to count')
    expect(renderToStaticMarkup(<WithHost><Results onOpenDay={() => undefined}
      dive={withSetups({ ...build([]), tags: [] }, [toDiveSetup(day('2026-10-06', 'buy', {}), [])])} /></WithHost>)).toContain('No tags yet')
  })
})

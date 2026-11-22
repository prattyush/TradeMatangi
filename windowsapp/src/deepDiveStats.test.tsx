import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import StatsPanel from '../../shared/deepdive/ui/StatsPanel'
import RoundTripLabelForm from '../../shared/analysis/labeling/RoundTripLabelForm'
import { blankLabel } from '../../shared/analysis/labeling/model'
import type { StatsAllEntry, StatsBlock, TagStat } from '../../shared/deepdive/types'

const stat = (name: string, valid: number, notValid: number): TagStat => {
  const marked = valid + notValid
  return { tag_id: name, name, valid, not_valid: notValid, marked, pct: marked ? Math.round((1000 * valid) / marked) / 10 : null, few_days: marked < 5 }
}
const block = (days: number, tags: TagStat[], extra: Partial<StatsBlock> = {}): StatsBlock => ({
  days, buy_days: 0, sell_days: 0, tags, success: 0, failed: 0, with_outcome: 0, success_pct: null, outcome_few_days: true, ...extra,
})
// Buy setups (bullish): second leg usually follows; Sell setups (bearish): it rarely does.
const entry = (shared = false): StatsAllEntry => ({
  category: 'Breakout', strategy: 'ORB', owner_id: 'owner', shared,
  all: block(14, [stat('Second leg', 10, 4), stat('Double top', 1, 3)], { success: 8, failed: 4, with_outcome: 12, success_pct: 66.7 }),
  buy: block(8, [stat('Second leg', 7, 1), stat('Double top', 0, 2)], { success: 6, failed: 1, with_outcome: 7, success_pct: 85.7 }),
  sell: block(6, [stat('Second leg', 3, 3), stat('Double top', 1, 1)], { success: 2, failed: 3, with_outcome: 5, success_pct: 40 }),
})
const panel = (trade: { right?: string | null; action?: string | null }, entries = [entry()], strategy = 'ORB') =>
  renderToStaticMarkup(<StatsPanel entries={entries} category="Breakout" strategy={strategy} trade={trade} />)

describe('StatsPanel', () => {
  it('opens on the side the position profits from and shows that side\'s numbers', () => {
    const longEquity = panel({ action: 'BUY' })
    expect(longEquity).toContain('this position is Buy-side')
    expect(longEquity).toContain('87.5%') // 7 of 8 buy days
    expect(longEquity).toContain('Success 6 of 7 (85.7%)')
    const shortEquity = panel({ action: 'SELL' })
    expect(shortEquity).toContain('this position is Sell-side')
    expect(shortEquity).toContain('Success 2 of 5 (40%)')
  })

  it('reads a bought PE as Sell and a sold PE as Buy, a bought CE as Buy and a sold CE as Sell', () => {
    const side = (right: string, action: string) => /this position is (Buy|Sell)-side/.exec(panel({ right, action }))![1]
    expect([side('CE', 'BUY'), side('CE', 'SELL'), side('PE', 'BUY'), side('PE', 'SELL')]).toEqual(['Buy', 'Sell', 'Sell', 'Buy'])
  })

  it('opens on All when the direction is unknown', () => {
    const html = panel({})
    expect(html).not.toContain('this position is')
    expect(html).toContain('Success 8 of 12 (66.7%)')
    expect(html).toContain('All (14)')
    expect(html).toContain('Buy (8)')
    expect(html).toContain('Sell (6)')
  })

  it('lists tags with percentage and n, most frequent first, and warns about thin samples', () => {
    const html = panel({ action: 'BUY' })
    expect(html.indexOf('Second leg')).toBeLessThan(html.indexOf('Double top'))
    expect(html).toContain('(n=8)')
    expect(html).toContain('(n=2)')
    expect(html).toContain('Only 2 days marked')
  })

  it('says when a side has no days, and when a deep dive has no tags', () => {
    const none = entry(); none.sell = block(0, [])
    expect(panel({ action: 'SELL' }, [none])).toContain('No Sell days in this deep dive.')
    const bare = entry(); bare.all = block(3, []); bare.buy = block(3, [])
    expect(panel({ action: 'BUY' }, [bare])).toContain('This deep dive has no tags yet.')
  })

  it('caps the list and counts the rest', () => {
    const many = entry(); many.buy = block(8, Array.from({ length: 9 }, (_, i) => stat(`Tag ${i}`, i, 8 - i)))
    const html = panel({ action: 'BUY' }, [many])
    expect(html.match(/dd-stats-name/g)).toHaveLength(6)
    expect(html).toContain('+3 more in the deep dive')
  })

  it('says a shared deep dive is shared, and renders nothing for an unknown strategy or an empty dive', () => {
    expect(panel({ action: 'BUY' }, [entry(true)])).toContain('shared with you')
    expect(panel({ action: 'BUY' }, [entry()], 'Other')).toBe('')
    const empty = entry(); empty.all = block(0, [])
    expect(panel({ action: 'BUY' }, [empty])).toBe('')
    expect(panel({ action: 'BUY' }, [])).toBe('')
  })
})

describe('RoundTripLabelForm with a deep dive', () => {
  const form = (category: string, strategy: string, deepDive?: Parameters<typeof RoundTripLabelForm>[0]['deepDive']) => renderToStaticMarkup(
    <RoundTripLabelForm idPrefix="s1-0" label={{ ...blankLabel('s1', 0), expected_category: category, expected_strategy: strategy }} disabled={false}
      categories={['Breakout']} strategies={['ORB']} entryTags={[]} exitTags={[]} onChange={() => undefined} onCreateName={async (_, name) => name} deepDive={deepDive} />)

  it('shows the panel under the Expected Pattern once its strategy has a deep dive', () => {
    const html = form('Breakout', 'ORB', { entries: [entry()], trade: { right: 'PE', action: 'BUY' } })
    expect(html).toContain('Your deep dive')
    expect(html).toContain('this position is Sell-side')
    expect(html.indexOf('Expected Pattern')).toBeLessThan(html.indexOf('Your deep dive'))
    expect(html.indexOf('Your deep dive')).toBeLessThan(html.indexOf('Actual Pattern'))
  })

  it('shows nothing without a deep dive, without an expected strategy, or for a strategy that has none', () => {
    expect(form('Breakout', 'ORB')).not.toContain('Your deep dive')
    expect(form('', '', { entries: [entry()], trade: {} })).not.toContain('Your deep dive')
    expect(form('Breakout', 'Other', { entries: [entry()], trade: {} })).not.toContain('Your deep dive')
  })
})

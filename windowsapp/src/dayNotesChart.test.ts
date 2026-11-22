import { describe, expect, it } from 'vitest'
import { daySessions, daySymbols, tradesBySymbol } from '../../shared/analysis/notes/dayChartModel'
import { eventTimes } from '../../shared/analysis/dayScore/model'
import { baseHelp, ruleHelp, RULE_NUMBERS } from '../../shared/analysis/dayScore/ruleHelp'

const session = (id: string, symbol: string, extra: Record<string, unknown> = {}) => ({ session_id: id, symbol, trade_count: 2, ...extra }) as any
const trade = (id: string, timestamp: number) => ({ trade_id: id, timestamp }) as any

describe('the day chart (all symbols of a date)', () => {
  it('draws only the own intraday sessions that traded', () => {
    const kept = daySessions([
      session('a', 'NIFTY'), session('b', 'NIFTY', { trade_count: 0 }), session('c', 'BANKNIFTY', { shared: true }),
      session('d', 'NIFTY', { trading_style: 'swing' }), session('e', 'NIFTY', { practice: { category: 'x' } }), session('f', 'BANKNIFTY', { session_type: 'real' }),
    ])
    expect(kept.map(s => s.session_id)).toEqual(['a', 'f'])
  })
  it('lists each symbol once, in alphabetical order', () => {
    expect(daySymbols([session('a', 'NIFTY'), session('b', 'BANKNIFTY'), session('c', 'NIFTY')])).toEqual(['BANKNIFTY', 'NIFTY'])
  })
  it('puts the trades of all of a symbol\'s sessions together, oldest first', () => {
    const sessions = [session('a', 'NIFTY'), session('b', 'BANKNIFTY'), session('c', 'NIFTY')]
    const bySymbol = tradesBySymbol(sessions, [[trade('a2', 200), trade('a1', 100)], [trade('b1', 50)], [trade('c1', 150)]])
    expect(bySymbol.get('NIFTY')!.map(t => t.trade_id)).toEqual(['a1', 'c1', 'a2'])
    expect(bySymbol.get('BANKNIFTY')!.map(t => t.trade_id)).toEqual(['b1'])
  })
})

describe('the score rules explained in the Notes tab', () => {
  it('states the numbers in use', () => {
    expect(ruleHelp('drawdown').how).toContain('50% of the limit −8, 75% of the limit −14, 100% of the limit −25, 150% of the limit −35')
    expect(ruleHelp('repeat_entry').how).toContain('within 3 bars (9 minutes on 3-minute bars)')
    expect(ruleHelp('repeat_entry').how).toContain('−6 for the first, then −10, −16, −24 for each further one')
    expect(ruleHelp('add_to_loser').how).toContain('−6 for the first, then −10, −16, −24')
    expect(ruleHelp('clean_day').how).toContain('3 or more closed trades: +15; over 6 or more: +20')
    expect(ruleHelp('big_loss_wipes_gains').how).toContain('as big −10, 2 times as big −16, 3 times as big −22')
    expect(baseHelp).toContain(`${RULE_NUMBERS.base}`)
  })
  it('explains every rule with a reason', () => {
    for (const key of ['drawdown', 'repeat_entry', 'add_to_loser', 'clean_day', 'big_loss_wipes_gains'] as const) expect(ruleHelp(key).why.length).toBeGreaterThan(20)
  })
  it('lists when a rule found something, in order, on the market clock', () => {
    const at = (hhmm: string) => Date.parse(`2026-10-16T${hhmm}:00Z`) / 1000
    expect(eventTimes({ events: { repeat_entry: [{ time: at('11:15') }, { time: at('10:42') }, {}] } }, 'repeat_entry')).toEqual(['10:42', '11:15'])
    expect(eventTimes({ events: {} }, 'add_to_loser')).toEqual([])
    expect(eventTimes({}, 'drawdown')).toEqual([])
  })
})

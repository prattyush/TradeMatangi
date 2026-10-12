import { expect, it } from 'vitest'
import type { AnalysisTrade } from '../../shared/analysis/api'
import type { PerformanceCycle } from '../../shared/analysis/performance'
import { analysisMarkers, executionRoles } from './analysisMarkers'
const fill = (values: Partial<AnalysisTrade> = {}): AnalysisTrade => ({trade_id:'one', session_id:'session',user_id:'alice',symbol:'NIFTY',side:'BUY',quantity:40,price:100,timestamp:181,instrument_type:'options',right:'CE',strike:25000,expiry:'2026-10-08',commission:1,...values})
it('groups coincident executions chronologically and separates prices', () => {
  const markers = analysisMarkers([fill({trade_id:'late',execution_sort_time:3}), fill({trade_id:'early',execution_sort_time:2}), fill({trade_id:'other',price:101})],[],{right:'CE',strike:25000,expiry:'2026-10-08'})
  expect(markers).toHaveLength(2)
  expect(markers[0].trades.map(t=>t.trade_id)).toEqual(['early','late'])
  expect(markers[0].text).toBe('')
})
it('keeps exact expiry filtering and labels approximate underlying prices', () => {
  expect(analysisMarkers([fill({expiry:'2026-10-15'})],[],{right:'CE',strike:25000,expiry:'2026-10-08'})).toEqual([])
  const markers = analysisMarkers([fill()], [{time:180,close:25001}])
  expect(markers[0].price).toBe(25001)
  expect(markers[0].approximate).toBe(true)
  expect(markers[0].trades[0].price).toBe(100)
  expect(analysisMarkers([fill()],[])).toEqual([])
})
it('returns both reversal roles without matching another session', () => {
  const cycles = [
    {session_id:'session',cycle_id:'closed',executions:[{trade_id:'one',role:'exit',quantity:40}]},
    {session_id:'session',cycle_id:'short',executions:[{trade_id:'one',role:'entry',quantity:20}]},
    {session_id:'other',cycle_id:'other',executions:[{trade_id:'one',role:'entry',quantity:100}]},
  ] as PerformanceCycle[]
  expect(executionRoles(fill(),cycles).map(r=>[r.row.role,r.row.quantity])).toEqual([['exit',40],['entry',20]])
})

it.each(['CE', 'PE'])('suppresses %s option text including custom labels, keeping buy/sell colors', right => {
  const markers = analysisMarkers([fill({right}), fill({right,trade_id:'sell',side:'SELL',price:101})], [], {right,strike:25000,expiry:'2026-10-08'}, 'all', () => 'custom label')
  expect(markers.map(marker => [marker.color,marker.text])).toEqual([['#FFFFFF',''],['#00AAFF','']])
})
it('preserves underlying CE/PE labels and coincident counts', () => {
  const markers = analysisMarkers([fill({underlying_price:25001}), fill({trade_id:'pe',right:'PE',side:'SELL',underlying_price:25002})], [])
  expect(markers.map(marker => marker.text)).toEqual(['CE B','PE S'])
  expect(analysisMarkers([fill({underlying_price:25001}),fill({trade_id:'second',underlying_price:25001})],[])[0].text).toBe('2')
})

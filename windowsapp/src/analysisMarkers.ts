import type { AnalysisTrade } from '../../shared/analysis/api'
import type { PerformanceCycle } from '../../shared/analysis/performance'
export interface ExecutionMarker { key: string; timestamp: number; price: number; color: string; text: string; approximate: boolean; trades: AnalysisTrade[] }
export function analysisMarkers(trades: AnalysisTrade[], candles: { time: number; close: number }[], contract?: { right: string; strike: number; expiry: string;exchange?:string;product?:string }, filter = 'all', getText?: (trade: AnalysisTrade) => string): ExecutionMarker[] {
  const closes = new Map(candles.map(c => [c.time, c.close]))
  const groups = new Map<string, ExecutionMarker>()
  for (const trade of trades) {
    if (contract && (trade.right !== contract.right || trade.strike !== contract.strike || trade.expiry !== contract.expiry || (contract.exchange!=null&&trade.exchange!==contract.exchange) || (contract.product!=null&&trade.product!==contract.product))) continue
    if (!contract && filter !== 'all' && trade.right && trade.right !== filter) continue
    if (!Number.isFinite(trade.timestamp) || !Number.isFinite(trade.price) || trade.price <= 0) continue
    const timestamp = Math.floor(trade.timestamp / 180) * 180
    const approximate = !contract && Boolean(trade.right) && !(Number(trade.underlying_price) > 0)
    const price = !contract && trade.right ? (Number(trade.underlying_price) > 0 ? Number(trade.underlying_price) : closes.get(timestamp)) : trade.price
    if (price == null || !Number.isFinite(price) || price <= 0) continue
    const key = `${timestamp}:${price}`
    const buyDirection = !contract && trade.right === 'PE' ? trade.side === 'SELL' : trade.side === 'BUY'
    const text = getText?.(trade) ?? `${!contract && trade.right ? `${trade.right} ` : ''}${trade.side === 'BUY' ? 'B' : 'S'}`
    const current = groups.get(key)
    if (current) { current.trades.push(trade); current.text = String(current.trades.length); current.approximate ||= approximate }
    else groups.set(key, {key, timestamp, price, color: buyDirection ? '#FFFFFF' : '#00AAFF', text, approximate, trades: [trade]})
  }
  for (const group of groups.values()) group.trades.sort((a,b) => (a.execution_sort_time ?? a.timestamp*1e6)-(b.execution_sort_time ?? b.timestamp*1e6) || `${a.session_id}:${a.trade_id}`.localeCompare(`${b.session_id}:${b.trade_id}`))
  return [...groups.values()]
}
export function executionRoles(trade: AnalysisTrade, cycles: PerformanceCycle[]) {
  return cycles.filter(cycle => cycle.session_id === trade.session_id).flatMap(cycle => cycle.executions.filter(row => (row.execution_id || row.trade_id) === (trade.execution_id || trade.trade_id)).map(row => ({cycle, row})))
}

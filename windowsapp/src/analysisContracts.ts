import type { AnalysisTrade } from '../../shared/analysis/api'

export interface ContractTab { key: string; label: string; right: string; strike: number; expiry: string; exchange?: string; product?: string; trades: AnalysisTrade[] }
export function contractTabs(trades: AnalysisTrade[]): ContractTab[] {
  const tabs = new Map<string, ContractTab>()
  for (const trade of trades) {
    if (!trade.right || trade.strike == null || !trade.expiry) continue
    const key = [trade.right, trade.strike, trade.expiry, trade.exchange ?? '', trade.product ?? ''].join(':')
    if (!tabs.has(key)) tabs.set(key, {key, label: `${trade.right} ${trade.strike} · ${trade.expiry}${trade.exchange ? ` · ${trade.exchange}` : ''}${trade.product ? ` · ${trade.product}` : ''}`, right:trade.right,strike:trade.strike,expiry:trade.expiry,exchange:trade.exchange,product:trade.product,trades:[]})
    tabs.get(key)!.trades.push(trade)
  }
  return [...tabs.values()].sort((a,b)=>a.label.localeCompare(b.label))
}

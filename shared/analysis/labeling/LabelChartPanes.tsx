import { useEffect, useMemo, useState } from 'react'
import { AnalysisChart, OptionsChart } from '../TradeAnalysis'
import type { AnalysisTrade } from '../api'

interface Props {
  symbol: string
  date: string
  /** Executions to mark; the strike pane follows the option contracts found in them. */
  trades: AnalysisTrade[]
  historicalDays: number
  getMarkerText: (trade: AnalysisTrade) => string
  /** Candle-clock epoch seconds to centre both charts on. */
  focusTime?: number
}

interface Contract { key: string; label: string; right: string; strike: number; expiry: string; trades: AnalysisTrade[] }

/** Contracts present in the trades, calls before puts, ascending strike. */
export function contractsOf(trades: AnalysisTrade[]): Contract[] {
  const map = new Map<string, Contract>()
  for (const trade of trades) {
    if (!trade.right || trade.strike == null || !trade.expiry) continue
    const key = `${trade.right}-${trade.strike}-${trade.expiry}`
    if (!map.has(key)) map.set(key, { key, label: `${trade.right} ${trade.strike}`, right: trade.right, strike: trade.strike, expiry: trade.expiry, trades: [] })
    map.get(key)!.trades.push(trade)
  }
  return [...map.values()].sort((a, b) => (a.right !== b.right ? (a.right === 'CE' ? -1 : 1) : a.strike - b.strike))
}

const PHONE_QUERY = '(max-width: 900px)'
function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches === true)
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY)
    if (!query) return
    const change = () => setPhone(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return phone
}

/**
 * Label Trades charts for the website/webapp: the Underlying chart and the strike chart of the viewed
 * trade, stacked so every marker of the round trip is visible at once (on phones: one pane at a time).
 */
export default function LabelChartPanes({ symbol, date, trades, historicalDays, getMarkerText, focusTime }: Props) {
  const contracts = useMemo(() => contractsOf(trades), [trades])
  const [selected, setSelected] = useState('')
  const contract = contracts.find(item => item.key === selected) ?? contracts[0]
  const phone = usePhone()
  const [pane, setPane] = useState<'underlying' | 'strike'>('underlying')
  useEffect(() => { if (!contract) setPane('underlying') }, [contract])
  const showUnderlying = !phone || pane === 'underlying' || !contract
  const showStrike = Boolean(contract) && (!phone || pane === 'strike')
  return (
    <div className="tl-panes" data-pane={pane}>
      {contract && (
        <nav className="tl-pane-tabs" aria-label="Chart pane">
          <button type="button" aria-pressed={pane === 'underlying'} onClick={() => setPane('underlying')}>Underlying</button>
          <button type="button" aria-pressed={pane === 'strike'} onClick={() => setPane('strike')}>{contract.label}</button>
        </nav>
      )}
      {showUnderlying && (
        <div className="tl-pane tl-pane-underlying" aria-label="Underlying chart pane">
          <div className="tl-pane-chart">
            <AnalysisChart symbol={symbol} date={date} trades={trades} historicalDays={historicalDays} title={symbol}
              getMarkerText={getMarkerText} focusTime={focusTime} fill />
          </div>
        </div>
      )}
      {showStrike && contract && (
        <div className="tl-pane tl-pane-strike" aria-label="Strike chart pane">
          {contracts.length > 1 && (
            <div className="tl-contracts" role="group" aria-label="Option contracts">
              {contracts.map(item => (
                <button key={item.key} type="button" aria-pressed={item.key === contract.key} onClick={() => setSelected(item.key)}>{item.label}</button>
              ))}
            </div>
          )}
          <div className="tl-pane-chart">
            <OptionsChart symbol={symbol} date={date} strike={contract.strike} expiry={contract.expiry} right={contract.right}
              trades={contract.trades} historicalDays={historicalDays} getMarkerText={getMarkerText} labelContractMarkers focusTime={focusTime} fill />
          </div>
        </div>
      )}
    </div>
  )
}

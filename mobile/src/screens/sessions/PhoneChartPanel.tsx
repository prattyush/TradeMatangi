import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AnalysisTrade } from '../../../../shared/analysis/api'
import AnalysisChart from '../../../../shared/analysis/kline/AnalysisChart'
import { contractTabs } from '../../../../shared/analysis/kline/analysisContracts'
import { useBackHandler } from '../../app/Nav'
import { PopoverMenu } from '../../shell/PopoverMenu'

type Pane = 'underlying' | 'option'

/**
 * The session chart for a landscape phone. All its controls share the one row at the top of the chart:
 * the host's controls (Days, view menu), Underlying | Option, the strike menu when Option is chosen, then the
 * chart's own interval, indicators, fit and maximize. Nothing else takes height from the candles.
 */
export function PhoneChartPanel({ symbol, date, trades, historicalDays, toolbarLead }: {
  symbol: string; date: string; trades: AnalysisTrade[]; historicalDays: number; toolbarLead: ReactNode
}) {
  const contracts = useMemo(() => contractTabs(trades), [trades])
  const [pane, setPane] = useState<Pane>('underlying')
  const [selected, setSelected] = useState('')
  const [maximized, setMaximized] = useState(false)
  useEffect(() => { setPane('underlying'); setSelected(''); setMaximized(false) }, [symbol, date])
  const contract = contracts.find(item => item.key === selected) ?? contracts[0]
  const showOption = pane === 'option' && contract !== undefined
  useBackHandler(maximized ? () => { setMaximized(false); return true } : null)

  const toolbarStart = (
    <div className="phone-toolbar-start">
      {maximized ? null : toolbarLead}
      {contracts.length > 0 && (
        <div className="segmented" role="group" aria-label="Chart">
          <button type="button" aria-pressed={!showOption} onClick={() => setPane('underlying')}>Underlying</button>
          <button type="button" aria-pressed={showOption} onClick={() => setPane('option')}>Option</button>
        </div>
      )}
      {showOption && (contracts.length > 1
        ? <PopoverMenu ariaLabel="Option contract" value={contract.key} onChange={setSelected}
            items={contracts.map(item => ({ id: item.key, label: item.label, detail: item.expiry }))} />
        : <span className="contract-pill" title={`${contract.expiry}`}>{contract.label}</span>)}
    </div>
  )

  return (
    <div className={`phone-chart${maximized ? ' maximized' : ''}`}>
      {showOption ? (
        <AnalysisChart key={contract.key} symbol={symbol} date={date} trades={contract.trades} right={contract.right} strike={contract.strike}
          expiry={contract.expiry} exchange={contract.exchange} product={contract.product} historicalDays={historicalDays}
          isMaximized={maximized} onMaximize={() => setMaximized(value => !value)} toolbarStart={toolbarStart} />
      ) : (
        <AnalysisChart key="underlying" symbol={symbol} date={date} trades={trades} historicalDays={historicalDays} title="Underlying"
          isMaximized={maximized} onMaximize={() => setMaximized(value => !value)} toolbarStart={toolbarStart} />
      )}
    </div>
  )
}

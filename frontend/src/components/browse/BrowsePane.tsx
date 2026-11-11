import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { AnalysisProvider, useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import type { SymbolChoice } from '../../../../shared/SymbolSearch'
import { browseApi, loadOlderPage } from '../../services/browseApi'
import { useWebsiteKLineEnvironment } from '../../services/analysisEnvironment'
import { paneTitle, type BrowsePane as Pane } from '../../services/browseWorkspace'
import { formatBrowseDate } from '../../../../shared/browse/browseModel.ts'
import { KLineAnalysisScope } from '../analysis/KLineAnalysis'
import { BrowsePaneMenu } from './BrowsePaneMenu'
import { usePaneContract } from './usePaneContract'

// KLine is loaded the first time Browse opens, not with the trading screen.
const AnalysisChart = lazy(() => import('../../../../shared/analysis/kline/AnalysisChart'))

/** Days of context an option pane loads before its day: about three days in all, as Browse always showed. */
const OPTION_CONTEXT_DAYS = 2

type SymbolInfo = SymbolChoice & { strike_interval?: number }

function PaneChart({ pane, symbols, today, onPatch, onMaximize, isMaximized }: {
  pane: Pane; symbols: SymbolInfo[]; today: string; onPatch: (id: number, change: Partial<Pane>) => void; onMaximize: () => void; isMaximized: boolean
}) {
  const environment = useAnalysisEnvironment()
  const [menuOpen, setMenuOpen] = useState(false)
  const minutes = environment.intervalMinutes ?? 3
  const patch = useCallback((change: Partial<Pane>) => onPatch(pane.id, change), [onPatch, pane.id])
  const contract = usePaneContract(pane, symbols.find(item => item.symbol === pane.symbol)?.strike_interval, patch)
  const spot = pane.kind === 'spot'
  const ready = spot || (pane.strike !== null && pane.expiry !== null)
  // Index and equity charts scroll back to a year or more through the paged route; option charts keep their few days.
  const loadOlder = useMemo(() => (spot ? (before: number) => loadOlderPage(pane.symbol, minutes, pane.date, before) : undefined), [spot, pane.symbol, pane.date, minutes])
  const menu = <BrowsePaneMenu pane={pane} symbols={symbols} today={today} contract={contract} onChange={next => patch(next)} open={menuOpen} onOpenChange={setMenuOpen} />
  if (!ready) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 8, background: '#0d1117' }}>
        <div>{menu}</div>
        <p role="status" style={{ color: '#8b949e', fontSize: 12, margin: 0 }}>
          {contract.error ?? (contract.loading ? "Loading the day's contracts…" : contract.searching ? 'Finding the strike…' : contract.note ?? (pane.pick.mode === 'max_price' ? 'Choose a premium cap in the pane menu.' : 'Choose a strike in the pane menu.'))}
        </p>
      </div>
    )
  }
  return (
    <Suspense fallback={<p role="status" style={{ color: '#8b949e', fontSize: 12, padding: 8 }}>Loading chart…</p>}>
      <AnalysisChart
        key={`${pane.symbol}:${pane.kind}:${pane.strike}:${pane.expiry}:${pane.date}`}
        symbol={pane.symbol} date={pane.date} historicalDays={spot ? 2 : OPTION_CONTEXT_DAYS}
        title={paneTitle(pane, formatBrowseDate)} toolbarStart={menu} loadOlder={loadOlder}
        {...(spot ? {} : { right: pane.kind, strike: pane.strike ?? undefined, expiry: pane.expiry ?? undefined })}
        onMaximize={onMaximize} isMaximized={isMaximized} />
    </Suspense>
  )
}

/** One Browse pane: its own provider (so its own interval, remembered), the minute-data api, and the one control in the chart's header. */
export function BrowsePane({ pane, symbols, today, onPatch, onMaximize, isMaximized }: {
  pane: Pane; symbols: SymbolInfo[]; today: string; onPatch: (id: number, change: Partial<Pane>) => void; onMaximize: () => void; isMaximized: boolean
}) {
  const base = useWebsiteKLineEnvironment()
  const value = useMemo(() => ({ ...base, api: browseApi as unknown as typeof base.api }), [base])
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <KLineAnalysisScope>
        <AnalysisProvider value={value} initialIntervalMinutes={pane.interval} onIntervalChange={interval => onPatch(pane.id, { interval })}>
          <PaneChart pane={pane} symbols={symbols} today={today} onPatch={onPatch} onMaximize={onMaximize} isMaximized={isMaximized} />
        </AnalysisProvider>
      </KLineAnalysisScope>
    </div>
  )
}

import { useCallback, useState } from 'react'
import type { SymbolChoice } from '../../../../shared/SymbolSearch'
import type { BrowsePane as Pane } from '../../services/browseWorkspace'
import { BrowseChart } from './BrowseChart'
import { BrowsePaneMenu } from './BrowsePaneMenu'
import { usePaneContract } from './usePaneContract'

type SymbolInfo = SymbolChoice & { strike_interval?: number }

/**
 * One Browse pane: the chart (Lightweight or KLine, as the Trading Chart setting says) with the pane's one control in the
 * chart's own header. An option pane without a contract yet shows the control and what is missing instead of a chart.
 */
export function BrowsePane({ pane, symbols, today, active, onActivate, onPatch, onMaximize, isMaximized }: {
  pane: Pane; symbols: SymbolInfo[]; today: string; active: boolean; onActivate: () => void
  onPatch: (id: number, change: Partial<Pane>) => void; onMaximize: () => void; isMaximized: boolean
}) {
  // The menu's open state lives here, above the chart: another symbol rebuilds the chart (and the button in its header).
  const [menuOpen, setMenuOpen] = useState(false)
  const patch = useCallback((change: Partial<Pane>) => onPatch(pane.id, change), [onPatch, pane.id])
  const contract = usePaneContract(pane, symbols.find(item => item.symbol === pane.symbol)?.strike_interval, patch)
  const spot = pane.kind === 'spot'
  const ready = spot || (pane.strike !== null && pane.expiry !== null)
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
    <BrowseChart key={`${pane.symbol}:${pane.kind}:${pane.strike}:${pane.expiry}:${pane.date}`} pane={pane} ready={ready} active={active} onActivate={onActivate}
      onInterval={minutes => patch({ interval: minutes })} onMaximize={onMaximize} isMaximized={isMaximized} header={menu} />
  )
}

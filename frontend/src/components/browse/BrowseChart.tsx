import { useEffect, useRef, useState, type ReactNode } from 'react'
import TradingChartHost from '../TradingChartHost'
import type { BrowsePane } from '../../services/browseWorkspace'
import { useBrowseCandles } from './useBrowseCandles'

/**
 * A read-only Browse chart on the same chart host as the trading screen, so it is Lightweight or KLine as the Trading Chart
 * setting says. No session, orders or ticks: the series comes from `useBrowseCandles`, the pane's one control sits in the
 * chart's own header (`headerStart`).
 */
export function BrowseChart({ pane, ready, active, onActivate, onInterval, onMaximize, isMaximized, header }: {
  pane: BrowsePane; ready: boolean; active: boolean; onActivate: () => void; onInterval: (minutes: number) => void
  onMaximize: () => void; isMaximized: boolean; header: ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(360)
  useEffect(() => {
    if (!element.current) return
    let frame: number | undefined
    const observer = new ResizeObserver(entries => {
      const available = entries[0]?.contentRect.height
      if (!available || available <= 0) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = undefined; setHeight(previous => (previous === Math.floor(available) ? previous : Math.floor(available))) })
    })
    observer.observe(element.current)
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [])
  const data = useBrowseCandles(pane, pane.interval, ready)
  const spot = pane.kind === 'spot'
  return (
    <div ref={element} style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <TradingChartHost
        symbol={pane.symbol}
        tradingDate={pane.date}
        startTime={null}
        intervalMinutes={pane.interval}
        onIntervalChange={onInterval}
        historyMode="live"
        liveChart={false}
        paneType={spot ? 'equity' : 'options'}
        right={spot ? undefined : pane.kind as 'CE' | 'PE'}
        strike={spot ? undefined : pane.strike ?? undefined}
        expiry={spot ? undefined : pane.expiry ?? undefined}
        latestTick={null}
        externalCandles={data.candles}
        externalLoading={data.loading}
        externalMessage={data.message}
        externalLoadOlder={data.loadOlder}
        drawingStorageKey={`browse-drawings:${pane.symbol}:${pane.kind}:${pane.strike}:${pane.expiry}:${pane.interval}`}
        isActive={active}
        onActivate={onActivate}
        onMaximize={onMaximize}
        isMaximized={isMaximized}
        headerStart={header}
        height={height}
      />
    </div>
  )
}

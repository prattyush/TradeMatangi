import { useEffect, useRef, useState, type ReactNode } from 'react'
import TradingChartHost from '../TradingChartHost'
import { useWebsiteChartRenderer } from '../../hooks/useWebsiteChartRenderer'
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
  const renderer = useWebsiteChartRenderer()
  const [height, setHeight] = useState(360)
  // The chart gets the pane's height. The Lightweight chart draws its toolbar above the height it is given, so that toolbar
  // (which can wrap on a narrow pane) is taken off, or the time axis at the bottom would be cut off. KLine's height is the whole chart.
  useEffect(() => {
    const box = element.current
    if (!box) return
    let frame: number | undefined
    let watched: Element | null = null
    const measure = () => {
      frame = undefined
      const bar = box.querySelector<HTMLElement>('[data-chart-toolbar]')
      if (bar && bar !== watched) { watched = bar; observer.observe(bar) }
      const used = renderer === 'lightweight' ? (bar?.offsetHeight ?? 34) + 2 : 0
      const next = Math.max(120, Math.floor(box.clientHeight - used))
      setHeight(previous => (previous === next ? previous : next))
    }
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(box)
    // The toolbar appears after the first render of the chart: measure again once it has.
    const timers = [60, 300, 1000].map(delay => setTimeout(schedule, delay))
    schedule()
    return () => { observer.disconnect(); timers.forEach(clearTimeout); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [renderer, pane.symbol, pane.kind, pane.interval])
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

import { useEffect, useRef, useCallback } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
} from 'lightweight-charts'
import api, { OHLCCandle } from '../services/api'
import { useSSE } from '../hooks/useSSE'

interface Props {
  sseUrl: string | null
  onPriceUpdate: (price: number) => void
  onSessionEnded: () => void
}

const CANDLE_INTERVAL_SECONDS = 3 * 60

function toCandle(c: OHLCCandle): CandlestickData {
  return { time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }
}

export default function Chart({ sseUrl, onPriceUpdate, onSessionEnded }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const liveWindowRef = useRef<{ start: number; open: number; high: number; low: number; close: number } | null>(null)

  // Initialise chart
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 480,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 1 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641',
      downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#26a641',
      wickDownColor: '#f85149',
    })
    chartRef.current = chart
    seriesRef.current = series

    // Load historical data
    api.getHistorical().then(({ candles }) => {
      if (candles.length > 0) {
        series.setData(candles.map(toCandle))
        chart.timeScale().fitContent()
      }
    }).catch(console.error)

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [])

  const handleSSEMessage = useCallback((event: Record<string, unknown>) => {
    const series = seriesRef.current
    if (!series) return

    if (event.type === 'session_ended') {
      onSessionEnded()
      liveWindowRef.current = null
      return
    }

    if (event.type !== 'tick') return

    const tick = event as { type: string; time: number; open: number; high: number; low: number; close: number }
    onPriceUpdate(tick.close)

    const windowStart = Math.floor(tick.time / CANDLE_INTERVAL_SECONDS) * CANDLE_INTERVAL_SECONDS
    const live = liveWindowRef.current

    if (!live || live.start !== windowStart) {
      if (live) {
        series.update({
          time: live.start as Time,
          open: live.open,
          high: live.high,
          low: live.low,
          close: live.close,
        })
      }
      liveWindowRef.current = {
        start: windowStart,
        open: tick.open,
        high: tick.high,
        low: tick.low,
        close: tick.close,
      }
    } else {
      live.high = Math.max(live.high, tick.high)
      live.low = Math.min(live.low, tick.low)
      live.close = tick.close
    }

    const current = liveWindowRef.current!
    series.update({
      time: current.start as Time,
      open: current.open,
      high: current.high,
      low: current.low,
      close: current.close,
    })
  }, [onPriceUpdate, onSessionEnded])

  useSSE(sseUrl, handleSSEMessage)

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #30363d' }}
    />
  )
}

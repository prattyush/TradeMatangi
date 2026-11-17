import { useEffect, useRef, useState } from 'react'
import { createChart, type CandlestickData, type IChartApi, type ISeriesApi, type LineData, type Time } from 'lightweight-charts'
import api, { type OHLCCandle } from '../../services/api'
import { buildMarkers } from '../../../../shared/analysis/patternMarkers'
import { useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import type { DiveChartProps } from '../../../../shared/deepdive/ui/host'

const INTERVALS = [1, 2, 3, 5, 15, 30]

function ema(closes: number[], period: number): Array<number | null> {
  const k = 2 / (period + 1)
  const out: Array<number | null> = []
  let previous: number | null = null
  closes.forEach((close, index) => {
    if (index < period - 1) { out.push(null); return }
    previous = previous === null ? closes.slice(0, period).reduce((a, b) => a + b, 0) / period : close * k + previous * (1 - k)
    out.push(previous)
  })
  return out
}

/**
 * The Deep Dive chart for the website's Lightweight renderer: minute candles from the Patterns routes, EMA 9 and 21, the
 * day's pattern marks, and a click that reports the candle and price under it while `pickMode` is on. The candle interval is
 * the shared Analysis interval, so both charts of a day and the saved interval of the day stay in step with the KLine mode.
 */
export default function DeepDiveLightChart({ symbol, date, title, strike, right, expiry, historicalDays, annotations = [], activeStrategy, activeCategory, pickMode, onPick, pickHint, focusTime }: DiveChartProps) {
  const focus = useRef(focusTime)
  focus.current = focusTime
  const env = useAnalysisEnvironment()
  const interval = env.intervalMinutes ?? 3
  const container = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9 = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21 = useRef<ISeriesApi<'Line'> | null>(null)
  const pick = useRef({ pickMode, onPick })
  pick.current = { pickMode, onPick }
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; empty: boolean } | { status: 'error'; message: string }>({ status: 'loading' })

  useEffect(() => {
    const element = container.current
    if (!element) return
    const chart = createChart(element, {
      width: element.clientWidth || 600, height: element.clientHeight || 300,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      crosshair: { mode: 0 }, rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
    })
    candleSeries.current = chart.addCandlestickSeries({ upColor: '#26a641', downColor: '#f85149', borderVisible: false, wickUpColor: '#26a641', wickDownColor: '#f85149' })
    ema9.current = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ema21.current = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    chartRef.current = chart
    chart.subscribeClick(param => {
      if (!pick.current.pickMode || !param.point || !param.time || !candleSeries.current) return
      const price = candleSeries.current.coordinateToPrice(param.point.y)
      if (price === null) return
      pick.current.onPick?.({ time: param.time as number, price })
    })
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    observer.observe(element)
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; candleSeries.current = null }
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    const request = right && strike && expiry
      ? api.patternOhlcOptions(symbol, date, strike, expiry, right, interval, historicalDays)
      : api.patternOhlcEquity(symbol, date, interval, historicalDays)
    request.then(response => {
      if (cancelled || !candleSeries.current || !ema9.current || !ema21.current) return
      const candles: OHLCCandle[] = response.candles ?? []
      candleSeries.current.setData(candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }) as CandlestickData))
      const closes = candles.map(c => c.close)
      const toLine = (values: Array<number | null>): LineData[] => values.flatMap((value, index) => (value === null ? [] : [{ time: candles[index].time as Time, value }]))
      ema9.current.setData(toLine(ema(closes, 9)))
      ema21.current.setData(toLine(ema(closes, 21)))
      // Centre on the trade when there is one (its candle a little left of the middle, room to the right), else show the whole day.
      const at = focus.current === undefined ? -1 : candles.findIndex(c => c.time >= (focus.current as number))
      if (at >= 0) chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, at - 25), to: at + 70 })
      else chartRef.current?.timeScale().fitContent()
      setState({ status: 'ready', empty: candles.length === 0 })
    }).catch(error => { if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
  }, [symbol, date, strike, right, expiry, interval, historicalDays])

  useEffect(() => {
    candleSeries.current?.setMarkers(buildMarkers(annotations, activeStrategy ?? null, activeCategory ?? null) as never)
  }, [annotations, activeStrategy, activeCategory, state.status])

  return <div className="dd-light" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
    <div className="dd-light-bar">
      <span className="dd-light-title">{title ?? symbol}</span>
      <select aria-label="Candle interval" value={interval} onChange={e => env.setIntervalMinutes?.(Number(e.target.value))}>
        {INTERVALS.map(minutes => <option key={minutes} value={minutes}>{minutes}m</option>)}
      </select>
      {pickMode && pickHint && <span className="dd-light-hint">{pickHint}</span>}
      {state.status === 'loading' && <span className="dd-light-note" role="status">Loading…</span>}
      {state.status === 'ready' && state.empty && <span className="dd-light-note" role="status">No candles for this day.</span>}
      {state.status === 'error' && <span className="dd-light-error" role="alert">{state.message}</span>}
    </div>
    <div ref={container} className="dd-light-canvas" style={{ flex: 1, minHeight: 0, cursor: pickMode ? 'crosshair' : 'default' }} />
  </div>
}

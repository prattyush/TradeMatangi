import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  LineData,
  Time,
  MouseEventParams,
  IPriceLine,
  LineStyle,
} from 'lightweight-charts'
import api, { OHLCCandle, TickEvent, BarCandle, Trade, Order, Position } from '../services/api'

export type PaneType = 'equity' | 'options'

interface Props {
  symbol: string
  tradingDate: string
  startTime: string | null
  intervalMinutes: number
  latestTick: TickEvent | null   // pre-filtered by caller: null if not for this pane
  completedBar?: BarCandle | null  // stepwise: full OHLC for the just-completed bar
  onPriceUpdate?: (price: number) => void
  height?: number
  // Options pane config
  paneType?: PaneType
  strike?: number
  expiry?: string
  right?: 'CE' | 'PE'
  // Active pane highlighting
  isActive?: boolean
  onActivate?: () => void
  // Trade markers
  trades?: Trade[]
  // Open order price lines
  openOrders?: Order[]
  // Price-pick mode: when non-null, a chart click calls this instead of draw mode
  onPriceSelect?: ((price: number) => void) | null
  // Maximize / restore this pane
  onMaximize?: () => void
  isMaximized?: boolean
  // For mid-session panes: timestamp from which live ticks begin (candles before this are history)
  liveFromTs?: number
  // Increment to trigger a manual data reload (fixes phantom candle after strike change)
  reloadKey?: number
  // Number of prior trading days to load for chart context (default 2)
  historicalDays?: number
  // Latest equity tick timestamp — used as fallback cutoff when this pane's latestTick is null
  currentSimTime?: number | null
  // Position for this pane — used to annotate stoploss label with projected P&L
  position?: Position
  pnlPctMode?: boolean
  sessionCapital?: number
}

type DrawMode = 'none' | 'hline' | 'trendline' | 'fibretracement' | 'channel'

type Drawing =
  | { type: 'hline'; ref: IPriceLine }
  | { type: 'trendline' | 'fibretracement' | 'channel'; refs: ISeriesApi<'Line'>[] }

const FIB_LEVELS = [
  { ratio: 0,    color: '#e6edf3', label: '0' },
  { ratio: 0.25, color: '#34d399', label: '25' },
  { ratio: 0.5,  color: '#60a5fa', label: '50' },
  { ratio: 0.75, color: '#fbbf24', label: '75' },
  { ratio: 1.0,  color: '#e6edf3', label: '100' },
]

const DRAW_LABEL: Partial<Record<DrawMode, string>> = {
  hline: 'H-Line',
  trendline: 'Trend',
  fibretracement: 'Fib',
  channel: 'Channel',
}

const CANDLE_INTERVAL_SECS = (m: number) => m * 60

function toCandle(c: OHLCCandle): CandlestickData {
  return { time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }
}

function nextEMA(prev: number, close: number, k: number): number {
  return close * k + prev * (1 - k)
}

function computeEMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return []
  const result: (number | null)[] = []
  const k = 2 / (period + 1)
  let ema: number | null = null
  let warmup = 0
  let sum = 0
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]
    warmup++
    if (warmup < period) {
      result.push(null)
    } else if (warmup === period) {
      ema = sum / period
      result.push(ema)
    } else {
      ema = nextEMA(ema!, closes[i], k)
      result.push(ema)
    }
  }
  return result
}

export default function Chart({
  symbol, tradingDate, startTime, intervalMinutes,
  latestTick, completedBar, onPriceUpdate, height = 380,
  paneType = 'equity', strike, expiry, right,
  isActive = false, onActivate,
  trades = [],
  openOrders,
  onPriceSelect = null,
  onMaximize,
  isMaximized = false,
  liveFromTs,
  reloadKey = 0,
  historicalDays,
  currentSimTime,
  position,
  pnlPctMode,
  sessionCapital,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const liveWindowRef = useRef<{ start: number; open: number; high: number; low: number; close: number } | null>(null)
  const lastEma9Ref = useRef<number | null>(null)
  const lastEma21Ref = useRef<number | null>(null)
  const candleTimesRef = useRef<number[]>([])
  const latestTickRef = useRef(latestTick)
  const currentSimTimeRef = useRef(currentSimTime)
  const drawModeRef = useRef<DrawMode>('none')
  const drawPtsRef = useRef<{ time: number; price: number }[]>([])
  const drawingsRef = useRef<Drawing[]>([])
  const ignoreNextClickRef = useRef(false)
  const tradeMarkerPool = useRef<ISeriesApi<'Line'>[]>([])
  const orderPriceLinesRef = useRef<Map<string, IPriceLine>>(new Map())
  const onPriceSelectRef = useRef<((price: number) => void) | null>(null)
  const drawDropdownRef = useRef<HTMLDivElement>(null)

  const [showEma, setShowEma] = useState(true)
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [drawStep, setDrawStep] = useState(0)
  const [drawingCount, setDrawingCount] = useState(0)
  const [drawDropdownOpen, setDrawDropdownOpen] = useState(false)
  const [localReloadKey, setLocalReloadKey] = useState(0)

  // effectiveReloadKey combines the external reloadKey prop with the local one
  // so both parent-triggered and toolbar-triggered reloads work.
  const effectiveReloadKey = reloadKey + localReloadKey

  latestTickRef.current = latestTick
  currentSimTimeRef.current = currentSimTime
  useEffect(() => { drawModeRef.current = drawMode }, [drawMode])
  useEffect(() => { onPriceSelectRef.current = onPriceSelect ?? null }, [onPriceSelect])
  useEffect(() => {
    if (!drawDropdownOpen) return
    const close = (e: MouseEvent) => {
      if (drawDropdownRef.current && !drawDropdownRef.current.contains(e.target as Node)) {
        setDrawDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [drawDropdownOpen])

  // ── Chart initialisation — runs once on mount only ───────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 0 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    chartRef.current = chart
    seriesRef.current = series
    ema9Ref.current = e9
    ema21Ref.current = e21

    chart.subscribeClick((param: MouseEventParams) => {
      if (!param.point || !seriesRef.current) return
      // Absorb the click that activated the draw mode (e.g. dropdown item click)
      if (ignoreNextClickRef.current) { ignoreNextClickRef.current = false; return }
      const price = seriesRef.current.coordinateToPrice(param.point.y)
      if (price === null) return

      // Price-pick mode takes priority — doesn't require a candle under the cursor
      if (onPriceSelectRef.current) {
        onPriceSelectRef.current(price)
        return
      }

      if (!param.time) return  // drawing modes need a time reference
      const time = param.time as number

      const mode = drawModeRef.current
      if (mode === 'hline') {
        const line = seriesRef.current.createPriceLine({
          price, color: '#e6edf3', lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: price.toFixed(0),
        })
        drawingsRef.current.push({ type: 'hline', ref: line })
        setDrawingCount(c => c + 1)
        setDrawMode('none')
      } else if (mode === 'trendline') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]
          setDrawStep(1)
        } else {
          const p1 = pts[0]
          const trendSeries = chartRef.current!.addLineSeries({
            color: '#ffa657', lineWidth: 1,
            priceLineVisible: false, lastValueVisible: false,
          })
          const ordered = [
            { time: Math.min(p1.time, time) as Time, value: p1.time <= time ? p1.price : price },
            { time: Math.max(p1.time, time) as Time, value: p1.time <= time ? price : p1.price },
          ]
          trendSeries.setData(ordered)
          drawingsRef.current.push({ type: 'trendline', refs: [trendSeries] })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []
          setDrawStep(0)
          setDrawMode('none')
        }
      } else if (mode === 'fibretracement') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]
          setDrawStep(1)
        } else {
          const p1 = pts[0]
          const tStart = Math.min(p1.time, time) as Time
          const tEnd = Math.max(p1.time, time) as Time
          const pLow = Math.min(p1.price, price)
          const pHigh = Math.max(p1.price, price)
          const range = pHigh - pLow
          const fibRefs: ISeriesApi<'Line'>[] = []
          for (const lvl of FIB_LEVELS) {
            const lvlPrice = pLow + range * lvl.ratio
            const s = chartRef.current!.addLineSeries({
              color: lvl.color, lineWidth: 1,
              priceLineVisible: false, lastValueVisible: false,
            })
            s.setData([
              { time: tStart, value: lvlPrice },
              { time: tEnd, value: lvlPrice },
            ])
            fibRefs.push(s)
          }
          drawingsRef.current.push({ type: 'fibretracement', refs: fibRefs })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []
          setDrawStep(0)
          setDrawMode('none')
        }
      } else if (mode === 'channel') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]
          setDrawStep(1)
        } else if (pts.length === 1) {
          drawPtsRef.current = [...pts, { time, price }]
          setDrawStep(2)
        } else {
          const [p1, p2] = pts
          const tStart = Math.min(p1.time, p2.time) as Time
          const tEnd = Math.max(p1.time, p2.time) as Time
          const baseStartPrice = p1.time <= p2.time ? p1.price : p2.price
          const baseEndPrice = p1.time <= p2.time ? p2.price : p1.price
          const timeDiff = (tEnd as number) - (tStart as number)
          const slope = timeDiff !== 0 ? (baseEndPrice - baseStartPrice) / timeDiff : 0
          const lineAt = (t: number) => baseStartPrice + slope * (t - (tStart as number))
          const offset = price - lineAt(time)
          const baseline = chartRef.current!.addLineSeries({
            color: '#ffa657', lineWidth: 1,
            priceLineVisible: false, lastValueVisible: false,
          })
          baseline.setData([
            { time: tStart, value: baseStartPrice },
            { time: tEnd, value: baseEndPrice },
          ])
          const parallel = chartRef.current!.addLineSeries({
            color: '#79c0ff', lineWidth: 1,
            priceLineVisible: false, lastValueVisible: false,
          })
          parallel.setData([
            { time: tStart, value: baseStartPrice + offset },
            { time: tEnd, value: baseEndPrice + offset },
          ])
          drawingsRef.current.push({ type: 'channel', refs: [baseline, parallel] })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []
          setDrawStep(0)
          setDrawMode('none')
        }
      }
    })

    const ro = new ResizeObserver(entries => {
      // Skip when the container is hidden (display:none during maximize of another pane)
      // to avoid applyOptions({ width: 0 }) which can corrupt the Lightweight Charts canvas.
      const w = entries[0].contentRect.width
      if (w > 0) chart.applyOptions({ width: w })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      tradeMarkerPool.current = []
      orderPriceLinesRef.current.clear()
      chart.remove()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chartRef.current?.applyOptions({ height })
  }, [height])

  useEffect(() => {
    ema9Ref.current?.applyOptions({ visible: showEma })
    ema21Ref.current?.applyOptions({ visible: showEma })
  }, [showEma])

  // ── Historical + pre-session — equity only ───────────────────────────────────
  // Both fetches run in parallel and are combined into a single series.setData()
  // call. This eliminates the race where a live tick's series.update(09:18) arrives
  // before getPreSession resolves; a subsequent series.update(09:15) would throw
  // "Cannot update oldest data". With setData() the combined history is committed
  // atomically before any live tick can cause an ordering conflict.
  useEffect(() => {
    if (paneType === 'options') return
    const series = seriesRef.current
    const e9 = ema9Ref.current
    const e21 = ema21Ref.current
    if (!series || !e9 || !e21) return

    liveWindowRef.current = null
    lastEma9Ref.current = null
    lastEma21Ref.current = null
    candleTimesRef.current = []

    let cancelled = false
    ;(async () => {
      try {
        const [{ candles: histCandles }, preCandles] = await Promise.all([
          api.getHistorical(symbol, tradingDate, intervalMinutes, historicalDays),
          (() => {
            // On refresh during a running session, extend pre-session to the current
            // sim time so completed candles (e.g. 09:15, 09:18, 09:21) are restored
            // immediately rather than rebuilt tick-by-tick. Guard with a date check so
            // stale ticks from a previous session never poison a different trading date.
            const currentTs = currentSimTimeRef.current
            if (currentTs != null) {
              const simDate = new Date(currentTs * 1000).toISOString().slice(0, 10)
              if (simDate === tradingDate) {
                const totalSecs = currentTs % 86400
                const h = Math.floor(totalSecs / 3600)
                const m = Math.floor((totalSecs % 3600) / 60)
                const s = totalSecs % 60
                const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
                return api.getPreSession(symbol, tradingDate, timeStr, intervalMinutes)
              }
            }
            return startTime ? api.getPreSession(symbol, tradingDate, startTime, intervalMinutes) : Promise.resolve([])
          })()
        ])
        if (cancelled) return

        const allCandles = [...histCandles, ...preCandles]
        if (allCandles.length === 0) return

        series.setData(allCandles.map(toCandle))
        chartRef.current?.timeScale().fitContent()
        candleTimesRef.current = allCandles.map(c => c.time)

        // If a session is running, restore the partial candle accumulation so
        // a remount (e.g., maximize toggling the DOM parent) doesn't reset the
        // current bar to just the latest tick's OHLC.
        const liveTs = currentSimTimeRef.current
        if (liveTs != null && allCandles.length > 0) {
          const iSecs = intervalMinutes * 60
          const last = allCandles[allCandles.length - 1]
          if (last.time === Math.floor(liveTs / iSecs) * iSecs) {
            liveWindowRef.current = { start: last.time, open: last.open, high: last.high, low: last.low, close: last.close }
          }
        }

        const closes = allCandles.map(c => c.close)
        const ema9vals = computeEMA(closes, 9)
        const ema21vals = computeEMA(closes, 21)

        const e9data: LineData[] = []
        const e21data: LineData[] = []
        for (let i = 0; i < allCandles.length; i++) {
          if (ema9vals[i] !== null) e9data.push({ time: allCandles[i].time as Time, value: ema9vals[i]! })
          if (ema21vals[i] !== null) e21data.push({ time: allCandles[i].time as Time, value: ema21vals[i]! })
        }
        e9.setData(e9data)
        e21.setData(e21data)

        const last9 = ema9vals.filter(v => v !== null)
        const last21 = ema21vals.filter(v => v !== null)
        if (last9.length) lastEma9Ref.current = last9[last9.length - 1]!
        if (last21.length) lastEma21Ref.current = last21[last21.length - 1]!
      } catch (err) {
        console.error(err)
      }
    })()
    return () => { cancelled = true }
  }, [symbol, tradingDate, intervalMinutes, paneType, startTime, effectiveReloadKey])

  // ── Historical data — options (full trading day, loads when session starts) ──
  // Backend caches options data during session start, so we wait for startTime.
  useEffect(() => {
    if (paneType !== 'options' || !strike || !expiry || !right) return
    if (!startTime) return
    const series = seriesRef.current
    const e9 = ema9Ref.current
    const e21 = ema21Ref.current
    if (!series || !e9 || !e21) return

    liveWindowRef.current = null
    lastEma9Ref.current = null
    lastEma21Ref.current = null
    candleTimesRef.current = []

    let cancelled = false
    api.getOptionsHistorical(symbol, tradingDate, strike, expiry, right, intervalMinutes, historicalDays)
      .then(({ candles }) => {
        if (cancelled) return
        // Only show candles BEFORE the session start window — live ticks will
        // append from startTime onwards. Loading future candles first would
        // cause "Cannot update oldest data" when the first live tick arrives.
        const normalizedStart = startTime.length === 5 ? startTime + ':00' : startTime
        const startTs = new Date(`${tradingDate}T${normalizedStart}Z`).getTime() / 1000
        const intervalSecs = intervalMinutes * 60
        const startWindowTs = Math.floor(startTs / intervalSecs) * intervalSecs
        // When ticks are flowing, compute the cutoff so all COMPLETED candle windows
        // are loaded from history and the current growing window is left to live ticks.
        // Priority: equity master-clock (currentSimTimeRef) → pane's own tick → liveFromTs
        // → startWindowTs. The equity clock is always the most current reference;
        // options ticks can lag behind due to data gaps, causing a stale cutoffTs that
        // excludes the most recently completed window.
        const liveTsNow = currentSimTimeRef.current ?? latestTickRef.current?.time ?? undefined
        const cutoffTs = liveTsNow
          ? Math.floor(liveTsNow / intervalSecs) * intervalSecs
          : liveFromTs
            ? Math.floor(liveFromTs / intervalSecs) * intervalSecs
            : startWindowTs
        const priorCandles = candles.filter(c => c.time < cutoffTs)

        series.setData(priorCandles.map(toCandle))
        candleTimesRef.current = priorCandles.map(c => c.time)

        // Restore current partial candle accumulation from historical data.
        // priorCandles excludes the current slot (c.time < cutoffTs) to prevent
        // "Cannot update oldest data" on the next live tick, but the current slot
        // candle may still exist in the full `candles` array. Restoring here means
        // a remount (e.g., maximize) continues bar accumulation rather than losing
        // the in-progress bar and restarting from the next arriving tick.
        const liveTsForRestore = currentSimTimeRef.current ?? latestTickRef.current?.time
        if (liveTsForRestore != null) {
          const partialCandle = candles.find(c => c.time === cutoffTs)
          if (partialCandle) {
            liveWindowRef.current = { start: partialCandle.time, open: partialCandle.open, high: partialCandle.high, low: partialCandle.low, close: partialCandle.close }
          }
        }

        if (priorCandles.length === 0) return
        chartRef.current?.timeScale().fitContent()

        const closes = priorCandles.map(c => c.close)
        const ema9vals = computeEMA(closes, 9)
        const ema21vals = computeEMA(closes, 21)

        const e9data: LineData[] = []
        const e21data: LineData[] = []
        for (let i = 0; i < priorCandles.length; i++) {
          if (ema9vals[i] !== null) e9data.push({ time: priorCandles[i].time as Time, value: ema9vals[i]! })
          if (ema21vals[i] !== null) e21data.push({ time: priorCandles[i].time as Time, value: ema21vals[i]! })
        }
        e9.setData(e9data)
        e21.setData(e21data)

        const last9 = ema9vals.filter(v => v !== null)
        const last21 = ema21vals.filter(v => v !== null)
        if (last9.length) lastEma9Ref.current = last9[last9.length - 1]!
        if (last21.length) lastEma21Ref.current = last21[last21.length - 1]!
      })
      .catch(console.error)
    return () => { cancelled = true }
  }, [symbol, tradingDate, intervalMinutes, paneType, strike, expiry, right, startTime, liveFromTs, effectiveReloadKey])

  // ── Live tick processing — latestTick is already filtered by caller ─────────
  const intervalSecs = CANDLE_INTERVAL_SECS(intervalMinutes)

  useEffect(() => {
    const series = seriesRef.current
    const e9 = ema9Ref.current
    const e21 = ema21Ref.current
    if (!latestTick || !series || !e9 || !e21) return

    onPriceUpdate?.(latestTick.close)

    const windowStart = Math.floor(latestTick.time / intervalSecs) * intervalSecs
    const live = liveWindowRef.current

    try {
      if (!live || live.start !== windowStart) {
        if (live) {
          series.update({ time: live.start as Time, open: live.open, high: live.high, low: live.low, close: live.close })
          const k9 = 2 / (9 + 1)
          const k21 = 2 / (21 + 1)
          if (lastEma9Ref.current !== null) {
            lastEma9Ref.current = nextEMA(lastEma9Ref.current, live.close, k9)
            e9.update({ time: live.start as Time, value: lastEma9Ref.current })
          }
          if (lastEma21Ref.current !== null) {
            lastEma21Ref.current = nextEMA(lastEma21Ref.current, live.close, k21)
            e21.update({ time: live.start as Time, value: lastEma21Ref.current })
          }
        }
        liveWindowRef.current = {
          start: windowStart,
          open: latestTick.open, high: latestTick.high, low: latestTick.low, close: latestTick.close,
        }
      } else {
        live.high = Math.max(live.high, latestTick.high)
        live.low = Math.min(live.low, latestTick.low)
        live.close = latestTick.close
      }

      const current = liveWindowRef.current!
      series.update({ time: current.start as Time, open: current.open, high: current.high, low: current.low, close: current.close })
    } catch (err) {
      // Chart may be disposed or have out-of-order timestamps; skip this tick
      console.warn('Chart update skipped:', err)
    }
  }, [latestTick, intervalSecs, onPriceUpdate])

  // ── Stepwise completed-bar: correct the chart after React-batched ticks ─────
  // Declared AFTER latestTick effect so it runs last in the same render cycle.
  // The backend sends the true aggregated OHLC in bar_paused; this overwrites
  // the doji that latestTick (which only sees the last batched tick) produced.
  // liveWindowRef is set to the correct bar so EMA computation works on the
  // next bar's window transition.
  useEffect(() => {
    const series = seriesRef.current
    if (!completedBar || !series) return
    try {
      series.update({
        time: completedBar.time as Time,
        open: completedBar.open,
        high: completedBar.high,
        low: completedBar.low,
        close: completedBar.close,
      })
      liveWindowRef.current = {
        start: completedBar.time,
        open: completedBar.open,
        high: completedBar.high,
        low: completedBar.low,
        close: completedBar.close,
      }
    } catch (err) {
      console.warn('Completed bar update skipped:', err)
    }
  }, [completedBar])

  // ── Session ended: close the last open candle ──────────────────────────────
  const prevStartTimeRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevStartTimeRef.current !== null && startTime === null) {
      liveWindowRef.current = null
    }
    prevStartTimeRef.current = startTime
  }, [startTime])

  // ── Trade markers — one transparent Line series per trade so each circle lands
  //    at its own exact execution price even when multiple trades share the same bar ──

  // Returns color + text for a CE/PE trade shown on the underlying equity chart.
  // CE Buy = bullish on underlying (Buy), CE Sell = bearish (Sell).
  // PE Buy = bearish on underlying (Sell), PE Sell = bullish (Buy) — direction inverted.
  function crossChartMarkerStyle(tradeRight: string, side: 'BUY' | 'SELL'): { color: string; text: string } {
    if (tradeRight === 'CE') {
      return side === 'BUY'
        ? { color: '#26a641', text: 'CB' }   // CE Buy  → underlying Buy  (green)
        : { color: '#cf6679', text: 'CS' }   // CE Sell → underlying Sell (pink-red)
    }
    // PE: direction inverted — buying puts = selling underlying
    return side === 'BUY'
      ? { color: '#9a6dd7', text: 'PS' }     // PE Buy  → underlying Sell (purple)
      : { color: '#d4a72c', text: 'PB' }     // PE Sell → underlying Buy  (amber)
  }

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    // Remove all previous marker series
    for (const s of tradeMarkerPool.current) {
      try { chart.removeSeries(s) } catch { /* disposed */ }
    }
    tradeMarkerPool.current = []

    const paneTrades = (trades ?? []).filter(t => {
      if (paneType !== 'equity') return t.right === right && t.strike === strike
      // Equity pane: own equity trades + CE/PE trades that have an underlying_price snapshot
      return !t.right || t.underlying_price !== undefined
    })
    if (paneTrades.length === 0) return

    for (const t of paneTrades) {
      // Use underlying_price for cross-chart CE/PE markers; trade price for equity markers
      const markerPrice = (paneType === 'equity' && t.right !== undefined && t.underlying_price !== undefined)
        ? t.underlying_price
        : t.price
      const slot = (Math.floor(t.timestamp / intervalSecs) * intervalSecs) as Time
      try {
        const s = chart.addLineSeries({
          lineVisible: false, crosshairMarkerVisible: false,
          lastValueVisible: false, priceLineVisible: false,
        })
        s.setData([{ time: slot, value: markerPrice }])

        let color: string
        let text: string
        if (paneType === 'equity' && t.right) {
          // CE/PE trade mirrored onto the underlying chart
          const style = crossChartMarkerStyle(t.right, t.side)
          color = style.color
          text = style.text
        } else {
          // Equity trade on its own chart (or options trade on its own options pane)
          color = t.side === 'BUY' ? '#FFFFFF' : '#00AAFF'
          text = t.side === 'BUY' ? 'B' : 'S'
        }

        s.setMarkers([{
          time: slot,
          position: 'inBar' as const,
          color,
          shape: 'circle' as const,
          text,
          size: 0.5,
        }])
        tradeMarkerPool.current.push(s)
      } catch { /* chart disposed mid-loop */ }
    }
  }, [trades, paneType, right, intervalSecs])

  // ── Open order price lines — dashed horizontal at limit/trigger price ────────
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return

    for (const line of orderPriceLinesRef.current.values()) {
      try { series.removePriceLine(line) } catch { /* disposed */ }
    }
    orderPriceLinesRef.current.clear()

    const pending = (openOrders ?? []).filter(o => {
      if (o.status !== 'PENDING') return false
      return paneType === 'equity' ? !o.right : o.right === right
    })

    for (const order of pending) {
      const price = order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price
      let label = (order.side === 'BUY' ? 'B' : 'S') + (order.order_type === 'LIMIT' ? 'L' : 'T')

      if (order.order_type === 'STOPLOSS' && position && position.side !== 'FLAT') {
        const dir = position.side === 'LONG' ? 1 : -1
        const grossPnl = dir * (order.trigger_price - position.avg_entry_price) * position.quantity
        let pnlStr: string
        if (pnlPctMode && sessionCapital && sessionCapital > 0) {
          const pct = (grossPnl / sessionCapital) * 100
          pnlStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
        } else {
          pnlStr = `${grossPnl >= 0 ? '+' : ''}${Math.round(grossPnl)}`
        }
        label = `ST ${pnlStr}`
      }

      try {
        const line = series.createPriceLine({
          price, color: '#AAAAAA', lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: label,
        })
        orderPriceLinesRef.current.set(order.order_id, line)
      } catch { /* disposed */ }
    }
  }, [openOrders, paneType, right, position, pnlPctMode, sessionCapital])

  const enterDrawMode = useCallback((mode: DrawMode) => {
    setDrawDropdownOpen(false)
    setDrawMode(drawModeRef.current === mode ? 'none' : mode)
    drawPtsRef.current = []
    setDrawStep(0)
    // Clear the guard: dropdown items near the canvas top may not trigger LWC's subscribeClick,
    // leaving the guard set from onMouseDown and absorbing the first canvas click.
    ignoreNextClickRef.current = false
  }, [])

  const clearLastDrawing = useCallback(() => {
    const drawing = drawingsRef.current.pop()
    if (!drawing) return
    if (drawing.type === 'hline') {
      try { seriesRef.current?.removePriceLine(drawing.ref) } catch { /* already removed */ }
    } else {
      for (const s of drawing.refs) {
        try { chartRef.current?.removeSeries(s) } catch { /* already removed */ }
      }
    }
    setDrawingCount(c => c - 1)
    setDrawMode('none')
    drawPtsRef.current = []
    setDrawStep(0)
  }, [])

  const toolbarBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px', fontSize: 11, borderRadius: 4,
    border: `1px solid ${active ? '#f0883e' : '#30363d'}`,
    background: active ? '#2a1a0a' : '#161b22',
    color: active ? '#f0883e' : '#8b949e',
    cursor: 'pointer',
  })

  // ── Reload handler — re-fetches historical data for the current pane ────────
  const handleReload = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setLocalReloadKey(k => k + 1)
    liveWindowRef.current = null
    lastEma9Ref.current = null
    lastEma21Ref.current = null
    candleTimesRef.current = []
  }, [])

  // ── Bar close countdown ────────────────────────────────────────────────────
  const barCountdown = (() => {
    if (!latestTick) return null
    const secsIntoBar = latestTick.time % intervalSecs
    const remaining = secsIntoBar === 0 ? intervalSecs : intervalSecs - secsIntoBar
    const m = Math.floor(remaining / 60)
    const s = remaining % 60
    return `${m}:${String(s).padStart(2, '0')}`
  })()

  // Pane header label
  const paneLabel = paneType === 'options' && strike && expiry && right
    ? `${right} ${strike} | Exp: ${expiry}`
    : `${symbol} ${intervalMinutes}m`

  const borderColor = isActive ? '#58a6ff' : '#30363d'

  return (
    <div
      onClick={onActivate}
      style={{
        display: 'flex', flexDirection: 'column',
        border: `1px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden',
        cursor: onActivate ? 'pointer' : 'default',
      }}
    >
      {/* Pane toolbar — paddingRight leaves room for the absolute-positioned ✕ remove button */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
        paddingRight: 36,
        background: '#161b22', borderBottom: '1px solid #21262d', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, color: isActive ? '#58a6ff' : '#8b949e', marginRight: 4 }}>
          {paneLabel}
        </span>

        <button onClick={e => { e.stopPropagation(); setShowEma(v => !v) }} style={toolbarBtnStyle(showEma)}>
          EMA 9/21
        </button>

        {/* Drawing tools dropdown */}
        <div style={{ position: 'relative' }} ref={drawDropdownRef}>
          <button
            onClick={e => { e.stopPropagation(); setDrawDropdownOpen(v => !v) }}
            style={toolbarBtnStyle(drawMode !== 'none')}
            title="Drawing tools"
          >
            {DRAW_LABEL[drawMode] ?? 'Draw'} ▾
          </button>
          {drawDropdownOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 100,
              background: '#161b22', border: '1px solid #30363d',
              borderRadius: 4, minWidth: 155, marginTop: 2,
            }}>
              {([
                { mode: 'hline',          label: '─ Horizontal Line' },
                { mode: 'trendline',      label: '↗ Trend Line' },
                { mode: 'fibretracement', label: '◫ Fib Retracement' },
                { mode: 'channel',        label: '⊟ Parallel Channel' },
              ] as { mode: DrawMode; label: string }[]).map(({ mode: m, label }) => (
                <div
                  key={m}
                  // onMouseDown fires before LWC's 'click' handler — set the guard here
                  // so the dropdown selection click is never forwarded to the chart.
                  onMouseDown={() => { if (m !== drawModeRef.current) ignoreNextClickRef.current = true }}
                  onClick={e => { e.stopPropagation(); enterDrawMode(m) }}
                  style={{
                    padding: '5px 10px', cursor: 'pointer', fontSize: 11,
                    color: drawMode === m ? '#f0883e' : '#e6edf3',
                    background: drawMode === m ? '#2a1a0a' : 'transparent',
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>

        {drawingCount > 0 && (
          <button onClick={e => { e.stopPropagation(); clearLastDrawing() }} style={toolbarBtnStyle(false)}>
            Clear
          </button>
        )}
        <button
          onClick={handleReload}
          title="Reload chart data up to the last closed candle (fixes phantom candle after strike change)"
          style={{ ...toolbarBtnStyle(false), fontSize: 13, padding: '2px 7px' }}
        >
          ↻
        </button>
        {onMaximize && (
          <button
            onClick={e => { e.stopPropagation(); onMaximize() }}
            title={isMaximized ? 'Restore pane layout' : 'Maximize this pane'}
            style={{ ...toolbarBtnStyle(false), fontSize: 13, padding: '2px 7px' }}
          >
            {isMaximized ? '⤡' : '⤢'}
          </button>
        )}
        {drawMode !== 'none' && (
          <span style={{ fontSize: 11, color: '#f0883e' }}>
            {drawMode === 'hline' && 'Click chart to place'}
            {drawMode === 'trendline' && (drawStep === 0 ? 'Click first point' : 'Click second point')}
            {drawMode === 'fibretracement' && (drawStep === 0 ? 'Click start point' : 'Click end point')}
            {drawMode === 'channel' && (drawStep === 0 ? 'Click baseline start' : drawStep === 1 ? 'Click baseline end' : 'Click channel offset point')}
          </span>
        )}
        {onPriceSelect && (
          <span style={{ fontSize: 11, color: '#3fb950', fontWeight: 600 }}>
            ⊕ Click to pick price
          </span>
        )}
        {barCountdown && (
          <span style={{
            marginLeft: 'auto', fontSize: 11,
            color: barCountdown.startsWith('0:') ? '#f0883e' : '#484f58',
            fontVariantNumeric: 'tabular-nums',
          }}>
            Bar close: {barCountdown}
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        style={{ width: '100%', cursor: (drawMode !== 'none' || onPriceSelect) ? 'crosshair' : 'default' }}
      />
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useAnalysisEnvironment } from '../environment'
import { dailyCandles, dailyGeometry, shortDate, type DailyCandle } from './summaryModel'

const WIDTH = 420
const HEIGHT = 120
const DAYS = 90
const cache = new Map<string, Promise<DailyCandle[]>>()

/** The daily candles of an index or equity ending at `date`, remembered for a while so stepping through a deck does not ask twice. */
export function loadDaily(request: NonNullable<ReturnType<typeof useAnalysisEnvironment>['drawingRequest']>, symbol: string, date: string): Promise<DailyCandle[]> {
  const key = `${symbol}|${date}`
  const known = cache.get(key)
  if (known) return known
  const path = `browse/history?${new URLSearchParams({ symbol, interval: '1440', date, days: String(DAYS) })}`
  const work = request(path, 'GET').then(page => dailyCandles(((page as { candles?: never[] } | null)?.candles ?? []), date, DAYS))
  cache.set(key, work)
  work.catch(() => cache.delete(key))
  while (cache.size > 40) cache.delete(cache.keys().next().value as string)
  return work
}

/**
 * A small chart of the underlying on the daily scale (about 90 days up to the day, the day highlighted) so the day is seen in its
 * larger setting. Only indices and equities have daily history, so for anything else, or without the host's data transport, it says
 * nothing instead of failing the card.
 */
export default function DailyChart({ symbol, date }: { symbol: string; date: string }) {
  const { drawingRequest } = useAnalysisEnvironment()
  const [state, setState] = useState<{ key: string; candles: DailyCandle[] } | 'failed' | null>(null)
  const key = `${symbol}|${date}`
  useEffect(() => {
    if (!drawingRequest || !symbol) return
    let live = true
    setState(null)
    loadDaily(drawingRequest, symbol, date).then(candles => { if (live) setState({ key, candles }) }, () => { if (live) setState('failed') })
    return () => { live = false }
  }, [drawingRequest, symbol, date, key])
  const geometry = useMemo(() => (state && state !== 'failed' && state.key === key ? dailyGeometry(state.candles, date, WIDTH, HEIGHT) : null), [state, key, date])
  if (!drawingRequest || !symbol) return null
  if (state === 'failed') return <p className="sm-muted" data-testid="daily-chart-unavailable">No daily chart for {symbol}.</p>
  if (!geometry) return <p className="sm-muted" role="status">Loading the daily chart…</p>
  if (!geometry.bars.length) return <p className="sm-muted">No daily candles for {symbol}.</p>
  const first = geometry.bars[0].date
  return <figure className="sm-daily" data-testid="daily-chart" aria-label={`${symbol} on the daily scale`}>
    <figcaption>{symbol} · daily · {shortDate(first)} to {shortDate(date)}</figcaption>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Daily candles of ${symbol}, ${date} highlighted`} preserveAspectRatio="none">
      {geometry.bars.map(bar => <g key={bar.date} className={`${bar.up ? 'up' : 'down'}${bar.highlighted ? ' day' : ''}`}>
        {bar.highlighted && <rect x={bar.x - geometry.step * 0.9} y={0} width={geometry.step * 1.8} height={HEIGHT} className="sm-daily-band" />}
        <line x1={bar.x} x2={bar.x} y1={bar.wickTop} y2={bar.wickBottom} />
        <rect x={bar.x - Math.max(0.8, geometry.step * 0.34)} y={bar.bodyTop} width={Math.max(1.6, geometry.step * 0.68)} height={Math.max(1, bar.bodyBottom - bar.bodyTop)} />
      </g>)}
    </svg>
    <span className="sm-daily-axis"><span>{Math.round(geometry.low).toLocaleString('en-IN')}</span><span>{Math.round(geometry.high).toLocaleString('en-IN')}</span></span>
  </figure>
}

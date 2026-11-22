import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnalysisEnvironment, useAnalysisError } from '../environment'
import type { PerformanceFilters } from '../performance'
import SummaryDayCard from './SummaryDay'
import SummaryDeck from './SummaryDeck'
import { modeName, money, totalsOf } from './summaryModel'
import type { DaySummary } from './types'
import './summary.css'

interface Props {
  defaultSymbol?: string
  defaultStartDate?: string
  defaultEndDate?: string
  defaultInstrumentType?: string
  defaultSessionType?: string
}
type Layout = 'list' | 'deck'
const LAYOUT_KEY = 'analysis-summary-layout'
const dateAgo = (days: number) => { const date = new Date(); date.setUTCDate(date.getUTCDate() - days); return date.toISOString().slice(0, 10) }
const savedLayout = (): Layout => { try { return localStorage.getItem(LAYOUT_KEY) === 'deck' ? 'deck' : 'list' } catch { return 'list' } }

/**
 * The Summary of the days in a filter (the Stats filters): a card per market date, newest first, or the same days as a deck to go
 * through one after another. Read only; the charts of a day are loaded only when its card is opened or the deck reaches it.
 */
export default function SummaryView(props: Props) {
  const environment = useAnalysisEnvironment()
  const source = environment.daySummary
  const [filters, setFilters] = useState<PerformanceFilters>({
    symbol: props.defaultSymbol ?? '', start_date: props.defaultStartDate || dateAgo(13), end_date: props.defaultEndDate || dateAgo(0),
    instrument_type: props.defaultInstrumentType ?? '', session_type: props.defaultSessionType === 'desktop_stepwise' ? 'stepwise' : props.defaultSessionType ?? '', client: '',
  })
  const [layout, setLayout] = useState<Layout>(savedLayout)
  const [deckStart, setDeckStart] = useState<string | undefined>()
  const [result, setResult] = useState<DaySummary | null>(null)
  const [error, setError] = useState('')
  useAnalysisError(error, 'Summary')
  const [loading, setLoading] = useState(false)
  const symbols = useRef(new Set<string>())
  const generation = useRef(0)

  useEffect(() => {
    if (!source) return
    const mine = ++generation.current
    setLoading(true); setError('')
    source.days(filters).then(
      value => { if (mine !== generation.current) return; for (const day of value.days) for (const item of day.symbols) symbols.current.add(item.symbol); setResult(value); setLoading(false) },
      cause => { if (mine !== generation.current) return; setError(cause instanceof Error ? cause.message : String(cause)); setResult(null); setLoading(false) },
    )
  }, [source, filters, environment.dataRevision])

  const choose = (next: Layout) => { setLayout(next); try { localStorage.setItem(LAYOUT_KEY, next) } catch { /* the choice is only a convenience */ } }
  const field = (name: string, value: string) => setFilters(previous => ({ ...previous, [name]: value }))
  const totals = useMemo(() => totalsOf(result?.days ?? []), [result])
  const symbolOptions = useMemo(() => [...new Set([...symbols.current, ...(filters.symbol ? [filters.symbol] : [])])].sort(), [result, filters.symbol])
  if (!source) return <p className="sm-muted">The Summary is not available in this client.</p>

  return <div className="sm" data-testid="summary">
    <div className="sm-filters" role="search" aria-label="Summary filters">
      <label>From<input type="date" aria-label="Summary from" value={filters.start_date} onChange={event => field('start_date', event.target.value)} /></label>
      <label>Through<input type="date" aria-label="Summary through" value={filters.end_date} onChange={event => field('end_date', event.target.value)} /></label>
      <label>Mode<select aria-label="Summary mode" value={filters.session_type} onChange={event => field('session_type', event.target.value)}>
        <option value="">All modes</option>{['paper', 'real', 'stepwise', 'sim'].map(mode => <option key={mode} value={mode}>{modeName(mode)}</option>)}
      </select></label>
      <label>Origin<select aria-label="Summary origin" value={filters.client} onChange={event => field('client', event.target.value)}>
        <option value="">Both clients</option><option value="website">Website</option><option value="desktop">Desktop</option>
      </select></label>
      <label>Symbol<select aria-label="Summary symbol" value={filters.symbol} onChange={event => field('symbol', event.target.value)}>
        <option value="">All symbols</option>{symbolOptions.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}
      </select></label>
      <label>Instrument<select aria-label="Summary instrument" value={filters.instrument_type} onChange={event => field('instrument_type', event.target.value)}>
        <option value="">All</option><option value="equity">Equity</option><option value="options">Options</option><option value="futures">Futures</option>
      </select></label>
      <span className="sm-spacer" />
      <div className="sm-layout" role="group" aria-label="Summary layout">
        <button type="button" aria-pressed={layout === 'list'} onClick={() => choose('list')}>List</button>
        <button type="button" aria-pressed={layout === 'deck'} onClick={() => { setDeckStart(undefined); choose('deck') }}>Deck</button>
      </div>
    </div>
    {error && <p role="alert" className="sm-error">The Summary could not be loaded: {error}</p>}
    {loading && !result && <p className="sm-muted" role="status">Loading the Summary…</p>}
    {result && <p className="sm-headline" data-testid="summary-headline" aria-live="polite">
      {totals.days} {totals.days === 1 ? 'day' : 'days'} · {totals.trades} closed trades · net {money(totals.net_pnl)} · {totals.winning_days} up, {totals.losing_days} down
      {result.truncated && <span className="sm-warn"> · showing the newest {result.days.length} of {result.total_days} days: narrow the dates to see the rest</span>}
      {loading && <span className="sm-muted"> · updating…</span>}
    </p>}
    {result && result.days.length === 0 && !loading && <p className="sm-muted" role="status">No trading days match these filters. Widen the dates or clear a filter.</p>}
    {result && result.days.length > 0 && (layout === 'deck'
      ? <SummaryDeck days={result.days} start={deckStart} onList={() => choose('list')} />
      : <div className="sm-list">{result.days.map(day => <SummaryDayCard key={day.date} day={day} onDeck={date => { setDeckStart(date); choose('deck') }} />)}</div>)}
  </div>
}

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import AnalysisChart from '../../../../shared/analysis/kline/AnalysisChart'
import { useAnalysisApi } from '../../../../shared/analysis/environment'
import { describeError, isNotAvailable } from '../../api/errors'
import { useServices } from '../../app/AppContext'
import { useLoad } from '../../app/useLoad'
import { PopoverMenu } from '../../shell/PopoverMenu'
import { ErrorState, NotAvailable, Spinner } from '../../shell/States'
import { DateSheet } from './DateSheet'
import { SymbolSheet } from './SymbolSheet'
import {
  FALLBACK_INSTRUMENTS, RECENTS_KEY, formatBrowseDate, latestBrowseDate, shiftTradingDay, strikeLadder, withRecent,
  type Instrument, type OptionMetadata,
} from './browseModel'
import '../sessions/sessions.css'
import './browse.css'

type Kind = 'spot' | 'CE' | 'PE'
/** The day and the days before it that the chart loads, as the desktop's Browse default. */
const CONTEXT_DAYS = 2

/** What Browse was showing when the user left it (another tab), so coming back finds the same chart. */
const remembered: { symbol: string; date: string | null; kind: Kind; strike: number | null } = { symbol: 'NIFTY', date: null, kind: 'spot', strike: null }

function readRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}
function writeRecents(recents: string[]) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)) } catch { /* private mode: the list just is not remembered */ }
}

/**
 * Browse: any supported symbol on any past day, as the underlying or as a CE / PE contract. Read-only: no orders,
 * no drawings. The one control row sits in the chart's own header so the candles get the height.
 */
export function BrowseScreen() {
  const { client } = useServices()
  const api = useAnalysisApi()
  const latest = useMemo(() => latestBrowseDate(), [])
  const [symbol, setSymbol] = useState(remembered.symbol)
  const [date, setDate] = useState(remembered.date ?? latest)
  const [kind, setKind] = useState<Kind>(remembered.kind)
  const [strike, setStrike] = useState<number | null>(remembered.strike)
  const [sheet, setSheet] = useState<'symbol' | 'date' | null>(null)
  const [recents, setRecents] = useState<string[]>(readRecents)
  useEffect(() => { Object.assign(remembered, { symbol, date, kind, strike }) }, [symbol, date, kind, strike])

  // The catalogue decides which symbols exist and which have options. An older server without it still offers NIFTY.
  const catalogue = useLoad(async signal => (await client.get<{ instruments: Instrument[] }>('/api/desktop/v1/catalogue', undefined, { signal })).instruments, [client])
  const instruments = catalogue.data ?? FALLBACK_INSTRUMENTS
  const instrument = instruments.find(item => item.symbol === symbol) ?? instruments[0]
  const optionEligible = instrument?.option_eligible === true
  useEffect(() => { if (kind !== 'spot' && catalogue.data && !optionEligible) { setKind('spot'); setStrike(null) } }, [kind, catalogue.data, optionEligible])

  // Options need the day's expiry, the strike gap and where the underlying was, to offer strikes near it.
  const wantOption = kind !== 'spot' && optionEligible
  const option = useLoad(async signal => {
    if (!wantOption) return null
    const [metadata, morning] = await Promise.all([
      client.get<OptionMetadata>('/api/desktop/v1/option-metadata', { symbol, as_of_date: date }, { signal }),
      api.getPreSession(symbol, date, '09:30:00', 1),
    ])
    const price = morning[morning.length - 1]?.close ?? 0
    return { metadata, ladder: metadata.available ? strikeLadder(price, metadata.strike_interval) : [] }
  }, [client, api, wantOption, symbol, date])
  const ladder = option.data?.ladder
  const expiry = option.data?.metadata.expiries[0]
  useEffect(() => {
    if (!ladder?.length) return
    // Keep the strike across days when it is still listed; otherwise the one nearest the money.
    setStrike(current => (current !== null && ladder.includes(current) ? current : ladder[Math.floor(ladder.length / 2)]))
  }, [ladder])

  function choose(next: string) {
    const known = instruments.find(item => item.symbol === next)
    setSymbol(next); setStrike(null)
    if (!known?.option_eligible) setKind('spot')
    const updated = withRecent(recents, next)
    setRecents(updated); writeRecents(updated)
    setSheet(null)
  }
  const changeDay = (next: string) => { setDate(next); setSheet(null) }

  const controls = (
    <div className="phone-toolbar-start browse-controls">
      <button type="button" className="menu-button symbol-button" aria-label={`Symbol: ${symbol}`} onClick={() => setSheet('symbol')}>
        <span>{symbol}</span><span aria-hidden="true" className="caret">▾</span>
      </button>
      <div className="day-stepper" role="group" aria-label="Day">
        <button type="button" aria-label="Previous day" onClick={() => setDate(shiftTradingDay(date, -1))}>‹</button>
        <button type="button" className="day-label" aria-label={`Day: ${formatBrowseDate(date)}`} onClick={() => setSheet('date')}>{formatBrowseDate(date)}</button>
        <button type="button" aria-label="Next day" disabled={date >= latest} onClick={() => setDate(shiftTradingDay(date, 1))}>›</button>
      </div>
      <div className="segmented" role="group" aria-label="Instrument">
        <button type="button" aria-pressed={kind === 'spot'} onClick={() => setKind('spot')}>Spot</button>
        <button type="button" aria-pressed={kind === 'CE'} disabled={!optionEligible} onClick={() => setKind('CE')}>CE</button>
        <button type="button" aria-pressed={kind === 'PE'} disabled={!optionEligible} onClick={() => setKind('PE')}>PE</button>
      </div>
      {wantOption && ladder && ladder.length > 0 && strike !== null && (
        <PopoverMenu ariaLabel="Strike" value={String(strike)} onChange={value => setStrike(Number(value))}
          items={ladder.map(value => ({ id: String(value), label: String(value) }))} buttonLabel={`${strike}${expiry ? ` · ${expiry.slice(5)}` : ''}`} />
      )}
    </div>
  )

  let body: ReactNode
  if (wantOption && option.loading && !option.data) body = <div className="browse-state"><Spinner label="Loading option details" /></div>
  else if (wantOption && option.error != null) {
    body = <div className="browse-state">{isNotAvailable(option.error)
      ? <NotAvailable what="Options" />
      : <ErrorState message={describeError(option.error)} onRetry={option.reload} />}</div>
  } else if (wantOption && option.data && !option.data.metadata.available) {
    body = <div className="browse-state"><p role="status">{option.data.metadata.unavailable_reason ?? 'No option contracts are available for this day.'}</p></div>
  } else if (wantOption && (strike === null || !expiry)) body = <div className="browse-state"><Spinner label="Choosing a strike" /></div>
  else if (wantOption) {
    body = <AnalysisChart key={`${symbol}:${kind}:${strike}:${expiry}:${date}`} symbol={symbol} date={date} historicalDays={CONTEXT_DAYS}
      right={kind} strike={strike!} expiry={expiry!} toolbarStart={controls} />
  } else {
    body = <AnalysisChart key={`${symbol}:${date}`} symbol={symbol} date={date} historicalDays={CONTEXT_DAYS} title={symbol} toolbarStart={controls} />
  }

  const chart = body !== null && !(wantOption && (option.loading || option.error != null || !option.data?.metadata.available || strike === null || !expiry))
  return (
    <section className="screen browse" aria-label="Browse">
      {!chart && <div className="browse-bar">{controls}</div>}
      <div className="phone-chart browse-chart">{body}</div>
      {sheet === 'symbol' && <SymbolSheet instruments={instruments} current={symbol} recents={recents} onPick={choose} onClose={() => setSheet(null)} />}
      {sheet === 'date' && <DateSheet date={date} latest={latest} onPick={changeDay} onClose={() => setSheet(null)} />}
    </section>
  )
}

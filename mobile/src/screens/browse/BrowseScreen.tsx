import { useEffect, useMemo, useState, type ReactNode } from 'react'
import AnalysisChart from '../../../../shared/analysis/kline/AnalysisChart'
import { useAnalysisApi, useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import { describeError, isNotAvailable } from '../../api/errors'
import { useServices } from '../../app/AppContext'
import { useLoad } from '../../app/useLoad'
import { PopoverMenu } from '../../shell/PopoverMenu'
import { ErrorState, NotAvailable, Spinner } from '../../shell/States'
import { DateSheet } from './DateSheet'
import { MaxPriceSheet } from './MaxPriceSheet'
import { SymbolSheet } from './SymbolSheet'
import {
  BROWSE_HISTORY_PATH, FALLBACK_INSTRUMENTS, PREPARE_PATH, RECENTS_KEY, emptyPicks, formatBrowseDate, isWeekday, keepStrike, latestBrowseDate, maxPriceRequest, readMaxPrice,
  shiftTradingDay, strikeLadder, withRecent,
  type Instrument, type OptionMetadata, type OptionRight, type PreparedPane, type RightPick,
} from './browseModel'
import type { OHLCCandle } from '../../../../frontend/src/services/api'
import { marketDate, optionInstrument, spotInstrument } from './live/liveModel'
import { useLiveBrowse } from './live/useLiveBrowse'
import '../sessions/sessions.css'
import './browse.css'

type Kind = 'spot' | 'CE' | 'PE'
/** The day and the days before it that the chart loads, as the desktop's Browse default. */
const CONTEXT_DAYS = 2

/** What Browse was showing when the user left it (another tab), so coming back finds the same chart. */
const remembered: { symbol: string; date: string | null; kind: Kind; picks: Record<OptionRight, RightPick> } = { symbol: 'NIFTY', date: null, kind: 'spot', picks: emptyPicks() }
/** The server searches up to 30 strikes, and may have to download their histories first. */
const MAX_PRICE_TIMEOUT_MS = 120_000

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
  const environment = useAnalysisEnvironment()
  // The last completed day is where Browse opens; today is selectable too (and is the only day with Live).
  const today = useMemo(() => marketDate(), [])
  const latest = useMemo(() => (isWeekday(today) ? today : shiftTradingDay(today, -1)), [today])
  const opening = useMemo(() => latestBrowseDate(), [])
  const [symbol, setSymbol] = useState(remembered.symbol)
  const [date, setDate] = useState(remembered.date ?? opening)
  const [kind, setKind] = useState<Kind>(remembered.kind)
  // CE and PE each keep their own strike (or Max Price cap), so switching side does not move the other one.
  const [picks, setPicks] = useState<Record<OptionRight, RightPick>>(remembered.picks)
  const [sheet, setSheet] = useState<'symbol' | 'date' | 'max' | null>(null)
  const [liveOn, setLiveOn] = useState(false)
  const [recents, setRecents] = useState<string[]>(readRecents)
  useEffect(() => { Object.assign(remembered, { symbol, date, kind, picks }) }, [symbol, date, kind, picks])
  // Scroll-back for the underlying: pages of whole trading days from the paged history route, back to a year or more.
  const intervalMinutes = environment.intervalMinutes ?? 3
  const loadOlder = useMemo(() => async (before: number): Promise<{ candles: OHLCCandle[]; more: boolean }> => {
    const page = await client.get<{ candles: OHLCCandle[]; more: boolean }>(BROWSE_HISTORY_PATH, { symbol, interval: intervalMinutes, date, before }, { timeoutMs: 60_000 })
    return { candles: page.candles, more: page.more }
  }, [client, symbol, intervalMinutes, date])

  // The catalogue decides which symbols exist and which have options. An older server without it still offers NIFTY.
  const catalogue = useLoad(async signal => (await client.get<{ instruments: Instrument[] }>('/api/desktop/v1/catalogue', undefined, { signal })).instruments, [client])
  const instruments = catalogue.data ?? FALLBACK_INSTRUMENTS
  const instrument = instruments.find(item => item.symbol === symbol) ?? instruments[0]
  const optionEligible = instrument?.option_eligible === true
  useEffect(() => { if (kind !== 'spot' && catalogue.data && !optionEligible) { setKind('spot'); setPicks(emptyPicks()) } }, [kind, catalogue.data, optionEligible])

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
  const right: OptionRight | null = kind === 'spot' ? null : kind
  const pick = right ? picks[right] : null
  const patchPick = (side: OptionRight, patch: Partial<RightPick>) => setPicks(current => ({ ...current, [side]: { ...current[side], ...patch } }))
  useEffect(() => {
    if (!ladder?.length) return
    // Keep each side's strike across days when it is still listed; otherwise the one nearest the money.
    setPicks(current => ({
      CE: current.CE.mode === 'manual' ? { ...current.CE, strike: keepStrike(current.CE.strike, ladder) } : current.CE,
      PE: current.PE.mode === 'manual' ? { ...current.PE, strike: keepStrike(current.PE.strike, ladder) } : current.PE,
    }))
  }, [ladder])

  // Max Price: the server finds the strike for this day and side (the desktop picker's search); it is searched again for each day.
  const cap = wantOption && pick?.mode === 'max_price' ? pick.cap : null
  const found = useLoad(async signal => {
    if (cap === null || !expiry || !right) return null
    const response = await client.post<{ panes?: PreparedPane[] }>(PREPARE_PATH, maxPriceRequest(symbol, date, expiry, right, cap), { signal, timeoutMs: MAX_PRICE_TIMEOUT_MS, retries: 0 })
    return readMaxPrice(response)
  }, [client, symbol, date, right, cap, expiry])
  const strike = pick ? (pick.mode === 'max_price' ? found.data?.strike ?? null : pick.strike) : null

  // Live: only for today, for the spot or the chosen option, with the desktop's live flow.
  const isToday = date === today && isWeekday(today)
  const liveWanted = liveOn && isToday
  useEffect(() => { if (!isToday) setLiveOn(false) }, [isToday])
  const liveInstrument = useMemo(() => {
    if (!instrument) return null
    if (!wantOption) return spotInstrument(symbol, instrument.exchange, instrument.chart_type)
    return strike !== null && expiry ? optionInstrument(symbol, instrument.exchange, expiry, strike, kind as 'CE' | 'PE') : null
  }, [instrument, wantOption, symbol, strike, expiry, kind])
  const live = useLiveBrowse({ enabled: liveWanted, instrument: liveInstrument, intervalMinutes: environment.intervalMinutes ?? 3 })

  function choose(next: string) {
    const known = instruments.find(item => item.symbol === next)
    setSymbol(next); setPicks(emptyPicks())
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
      {isToday && (
        <button type="button" className={`live-button${liveWanted ? ' on' : ''}`} aria-pressed={liveWanted} data-phase={liveWanted ? live.phase : 'off'}
          aria-label={liveWanted ? `Live: ${live.message}` : 'Live'} title={liveWanted ? live.message : 'Stream live ticks for today'} onClick={() => setLiveOn(value => !value)}>
          <span className="live-dot" aria-hidden="true" />Live
        </button>
      )}
      {wantOption && ladder && ladder.length > 0 && strike !== null && right && (
        <PopoverMenu ariaLabel="Strike" value={String(strike)} onChange={value => patchPick(right, { mode: 'manual', strike: Number(value) })}
          items={[...new Set([...ladder, strike])].sort((a, b) => a - b).map(value => ({ id: String(value), label: String(value) }))}
          actions={[{ id: 'max', label: 'Max price…', detail: pick?.mode === 'max_price' && pick.cap !== null ? `≤ ₹${pick.cap}` : undefined, onSelect: () => setSheet('max') }]}
          buttonLabel={pick?.mode === 'max_price' && pick.cap !== null ? `≤₹${pick.cap} · ${strike}` : `${strike}${expiry ? ` · ${expiry.slice(5)}` : ''}`} />
      )}
      {/* While Max price is still searching (or failed) there is no strike to list, but the cap can still be changed. */}
      {wantOption && right && strike === null && cap !== null && (
        <button type="button" className="menu-button" aria-haspopup="dialog" aria-label={`Max price: ${cap}`} onClick={() => setSheet('max')}>≤₹{cap}</button>
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
  } else if (wantOption && cap !== null && found.error != null) {
    body = (
      <div className="browse-state browse-max-error">
        {isNotAvailable(found.error)
          ? <NotAvailable what="Max price" />
          : <><p role="alert">{describeError(found.error)}</p><div className="sheet-actions"><button type="button" className="btn" onClick={found.reload}>Try again</button>
            <button type="button" className="btn" onClick={() => right && patchPick(right, { mode: 'manual', strike: keepStrike(null, ladder ?? []) })}>Manual strike</button></div></>}
      </div>
    )
  } else if (wantOption && cap !== null && strike === null) body = <div className="browse-state"><Spinner label={`Finding the ${right} strike at or below ₹${cap}`} /></div>
  else if (wantOption && (strike === null || !expiry)) body = <div className="browse-state"><Spinner label="Choosing a strike" /></div>
  else if (wantOption) {
    body = <AnalysisChart key={`${symbol}:${kind}:${strike}:${expiry}:${date}:${liveWanted}`} symbol={symbol} date={date} historicalDays={CONTEXT_DAYS}
      right={kind} strike={strike!} expiry={expiry!} toolbarStart={controls} liveCandles={liveWanted ? live.candles : undefined} />
  } else {
    body = <AnalysisChart key={`${symbol}:${date}:${liveWanted}`} symbol={symbol} date={date} historicalDays={CONTEXT_DAYS} title={symbol} toolbarStart={controls}
      liveCandles={liveWanted ? live.candles : undefined} loadOlder={liveWanted ? undefined : loadOlder} />
  }

  const chart = body !== null && !(wantOption && (option.loading || option.error != null || !option.data?.metadata.available || strike === null || !expiry || (cap !== null && found.error != null)))
  return (
    <section className="screen browse" aria-label="Browse">
      {!chart && <div className="browse-bar">{controls}</div>}
      <div className="phone-chart browse-chart">
        {body}
        {liveWanted && live.phase !== 'live' && (
          <div className="live-status" role="status" data-phase={live.phase}>
            <span>{live.message}</span>
            {live.phase === 'error' && <button type="button" className="btn" onClick={live.retry}>Try again</button>}
          </div>
        )}
      </div>
      {sheet === 'symbol' && <SymbolSheet instruments={instruments} current={symbol} recents={recents} onPick={choose} onClose={() => setSheet(null)} />}
      {sheet === 'max' && right && pick && (
        <MaxPriceSheet symbol={symbol} right={right} cap={pick.cap} active={pick.mode === 'max_price'}
          onUse={value => { patchPick(right, { mode: 'max_price', cap: value }); setSheet(null) }}
          onManual={() => { patchPick(right, { mode: 'manual', strike: strike ?? keepStrike(null, ladder ?? []) }); setSheet(null) }} onClose={() => setSheet(null)} />
      )}
      {sheet === 'date' && <DateSheet date={date} latest={latest} onPick={changeDay} onClose={() => setSheet(null)} />}
    </section>
  )
}

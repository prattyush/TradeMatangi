import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { friendlyError } from '../../deepdive/ui/errors'
import { formatDay, sideLabel } from '../../deepdive/model'
import { useFillWindow } from '../../deepdive/ui/useFillWindow'
import { contractFor, directionText, filterStrategies, instrumentName, matchedText, pnlText, saveText, timeRange, tradedMarks, tradeInstrument } from '../model'
import type { SaveTradedResult, TradedList, TradedStrategy, TradedTrade } from '../types'
import { TradedHostProvider, useTradedHost, type TradedHost } from './host'
import '../../deepdive/ui/deepdive.css'
import './traded.css'

const tradeKey = (trade: Pick<TradedTrade, 'session_id' | 'round_trip_index'>) => `${trade.session_id}#${trade.round_trip_index}`

/**
 * The Pattern Library's "From your trades": the strategies you have labelled on trades (as expected or actual), the trades
 * behind one, and each trade drawn on its bars with gold ⚑ BUY / ⚑ SELL marks, so it is plain that they are the orders you
 * really placed and not an ideal pattern. A trade can be copied into the day's pattern chart as ordinary marks, and edited.
 */
export default function TradedPatterns({ host }: { host: TradedHost }) {
  return <TradedHostProvider host={host}><TradedScreen /></TradedHostProvider>
}

function TradedScreen() {
  const { api } = useTradedHost()
  const [strategies, setStrategies] = useState<TradedStrategy[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<{ category: string; strategy: string } | null>(null)

  const load = useCallback(async () => {
    try { setStrategies(await api.summary()); setError(null) } catch (e) { setError(friendlyError(e)); setStrategies([]) }
  }, [api])
  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => filterStrategies(strategies ?? [], filter), [strategies, filter])
  return <div className="td">
    <aside className="td-strategies" aria-label="Strategies from your trades">
      <h3>From your trades{strategies ? ` (${strategies.length})` : ''}</h3>
      <p className="pl-muted">Every strategy you have labelled on a trade, as the one you expected or the one it turned out to be.</p>
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter strategies" aria-label="Filter strategies" />
      {error && <p className="pl-error" role="alert">{error}</p>}
      {strategies === null ? <p className="pl-muted">Loading…</p> : strategies.length === 0 && !error
        ? <p className="pl-muted">No labelled trades yet. Label trades in Analysis or right after you trade, and their strategies show up here.</p>
        : <ul>{shown.map(item => {
          const active = selected?.category === item.category && selected.strategy === item.strategy
          return <li key={`${item.category}::${item.strategy}`}>
            <button aria-pressed={active} onClick={() => setSelected({ category: item.category, strategy: item.strategy })}>
              <strong>{item.strategy}</strong>
              <span className="pl-muted">{item.category || 'No category'}</span>
              <span className="pl-muted">{item.trades} {item.trades === 1 ? 'trade' : 'trades'} · {item.expected} expected · {item.actual} actual · last {formatDay(item.last_date)}</span>
            </button>
          </li>
        })}</ul>}
      {strategies && strategies.length > 0 && shown.length === 0 && <p className="pl-muted">No strategy matches.</p>}
    </aside>
    <section className="td-main">
      {selected ? <StrategyTrades key={`${selected.category}::${selected.strategy}`} category={selected.category} strategy={selected.strategy} />
        : <p className="pl-muted td-empty">Choose a strategy to see the trades you labelled with it.</p>}
    </section>
  </div>
}

function StrategyTrades({ category, strategy }: { category: string; strategy: string }) {
  const { api } = useTradedHost()
  const [result, setResult] = useState<TradedList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.list({ category, strategy }).then(value => { if (alive) { setResult(value); setChosen(value.trades[0] ? tradeKey(value.trades[0]) : null) } },
      e => { if (alive) setError(friendlyError(e)) })
    return () => { alive = false }
  }, [api, category, strategy])

  const trade = result?.trades.find(item => tradeKey(item) === chosen) ?? null
  return <div className="td-strategy">
    <h3>{category ? `${category} / ` : ''}{strategy}</h3>
    {error && <p className="pl-error" role="alert">{error}</p>}
    {!result && !error && <p className="pl-muted">Loading trades…</p>}
    {result && <>
      <p className="pl-muted">
        {result.total} {result.total === 1 ? 'trade' : 'trades'}{result.truncated ? `, the newest ${result.trades.length + result.unavailable} shown` : ''}
        {result.unavailable > 0 ? ` · ${result.unavailable} could not be read` : ''}
      </p>
      {result.trades.length === 0 ? <p className="pl-muted">None of these trades could be read.</p> : <div className="td-table-wrap">
        <table className="dd-table td-table">
          <thead><tr><th>Day</th><th>Instrument</th><th>Position</th><th>Time</th><th>P&L</th><th>Strategy as</th><th>Session</th></tr></thead>
          <tbody>{result.trades.map(item => <tr key={tradeKey(item)} className={tradeKey(item) === chosen ? 'active' : ''}>
            <td><button className="dd-day-link" onClick={() => setChosen(tradeKey(item))}>{formatDay(item.date)}</button></td>
            <td>{instrumentName(item)}</td>
            <td>{item.side ? <span className={`dd-side-tag ${item.side}`}>{sideLabel(item.side)}</span> : null} <span className="pl-muted">{item.action === 'BUY' ? 'bought' : 'sold'}</span></td>
            <td>{timeRange(item)}</td>
            <td className={item.pnl >= 0 ? 'dd-ok' : 'dd-bad'}>{pnlText(item.pnl)}</td>
            <td>{matchedText(item.matched_as)}</td>
            <td className="pl-muted">{item.session_type}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {trade && <TradeViewer key={tradeKey(trade)} trade={trade} category={category} strategy={strategy} />}
    </>}
  </div>
}

function TradeViewer({ trade, category, strategy }: { trade: TradedTrade; category: string; strategy: string }) {
  const { api, Chart, historicalDays, onEdit } = useTradedHost()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; chartId?: string } | null>(null)
  const area = useRef<HTMLDivElement>(null)
  useFillWindow(area, { minHeight: 560 })
  const marks = useMemo(() => tradedMarks(trade, { category, strategy }), [trade, category, strategy])
  const contract = contractFor(trade)
  const instrument = tradeInstrument(trade)

  const save = async (edit: boolean) => {
    setBusy(true); setMessage(null)
    let saved: SaveTradedResult | null = null
    try {
      saved = await api.save(trade, { category, strategy })
      setMessage({ kind: 'ok', text: saveText(saved), chartId: saved.chart_id })
      if (edit) await onEdit(saved.chart_id)
    } catch (e) { setMessage({ kind: 'error', text: friendlyError(e) }) } finally { setBusy(false) }
  }

  const chartProps = { symbol: trade.symbol, date: trade.date, historicalDays, activeStrategy: strategy, activeCategory: category, focusTime: trade.entry.time }
  return <div className="td-viewer" ref={area}>
    <div className="td-viewer-head">
      <strong>{formatDay(trade.date)} · {instrumentName(trade)}</strong>
      <span>{directionText(trade)} · {timeRange(trade)} · <span className={trade.pnl >= 0 ? 'dd-ok' : 'dd-bad'}>{pnlText(trade.pnl)}</span></span>
      <span className="td-legend" title="Gold ⚑ marks are the orders you placed, on the 3-minute bar they happened in. They are your actual trade, not an ideal pattern.">⚑ gold = your actual orders</span>
      <span className="td-actions">
        <button disabled={busy} onClick={() => void save(false)} title="Copy this trade's entry and exit into the day's pattern chart as ordinary marks">Save as pattern chart</button>
        <button className="pl-primary" disabled={busy} onClick={() => void save(true)} title="Save the marks and open the chart in Annotate to edit them">Save and edit</button>
      </span>
    </div>
    {message && <p className={message.kind === 'error' ? 'pl-error' : 'pl-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>
      {message.text}
      {message.kind === 'ok' && message.chartId && <> <button onClick={() => void onEdit(message.chartId!)}>Open in Annotate</button></>}
    </p>}
    <div className="td-charts">
      <div className="td-chartbox">
        <Chart key={`ul-${tradeKey(trade)}`} {...chartProps} title={`${trade.symbol} · ${formatDay(trade.date)}`} annotations={instrument === 'underlying' ? marks : []} />
      </div>
      {contract && <div className="td-chartbox">
        <Chart key={`ct-${tradeKey(trade)}-${contract.strike}`} {...chartProps} title={`${trade.symbol} ${contract.right} ${contract.strike}`}
          strike={contract.strike} right={contract.right} expiry={contract.expiry} annotations={marks} />
      </div>}
    </div>
  </div>
}

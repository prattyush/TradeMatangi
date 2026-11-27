import { useState } from 'react'
import DayJourneyChart from '../DayJourneyChart'
import DayChart from '../notes/DayChart'
import DayScoreBadge from '../dayScore/DayScoreBadge'
import { scoreModeName } from '../dayScore/model'
import DailyChart from './DailyChart'
import { chartSymbol, clock, longDate, modeName, money, noteParts, percent, tone, tradeName } from './summaryModel'
import type { SummaryDay, SummaryTrade } from './types'

/** The figures of a day: totals line, strategies, label info, best and worst, and the day's note (only when written). */
export function DayFigures({ day }: { day: SummaryDay }) {
  const { totals, labels } = day
  const parts = noteParts(day.note)
  return <div className="sm-figures">
    <dl className="sm-totals" aria-label="Day totals">
      <div><dt>Net P&amp;L</dt><dd className={tone(totals.net_pnl)} data-testid="day-net">{money(totals.net_pnl)}</dd></div>
      <div><dt>% of capital</dt><dd className={tone(totals.pnl_pct)}>{percent(totals.pnl_pct)}</dd></div>
      <div><dt>Trades</dt><dd>{totals.trades}{day.open_trades > 0 && <small title="Still open: not counted"> +{day.open_trades} open</small>}</dd></div>
      <div><dt>Win %</dt><dd>{totals.win_pct == null ? '—' : `${totals.win_pct.toFixed(0)}%`}<small> {totals.wins}W {totals.losses}L</small></dd></div>
    </dl>
    {day.strategies.length > 0 && <table className="sm-table" aria-label="Strategies of the day">
      <thead><tr><th>Strategy</th><th>Trades</th><th>Win %</th><th>Net ₹</th><th>P&amp;L %</th><th>Mean %/trade</th></tr></thead>
      <tbody>{day.strategies.map(row => <tr key={row.strategy}>
        <th scope="row">{row.strategy}</th><td>{row.trades}</td><td>{row.win_pct == null ? '—' : `${row.win_pct.toFixed(0)}%`}</td>
        <td className={tone(row.net_pnl)}>{money(row.net_pnl)}</td><td className={tone(row.pnl_pct)}>{percent(row.pnl_pct)}</td><td className={tone(row.mean_pnl_pct)}>{percent(row.mean_pnl_pct)}</td>
      </tr>)}</tbody>
    </table>}
    <p className="sm-labels" data-testid="label-info">
      Labelled {labels.labelled} of {labels.closed}
      {labels.plan_followed + labels.plan_not_followed > 0 && <> · plan followed {labels.plan_followed} of {labels.plan_followed + labels.plan_not_followed}</>}
      {labels.labelled < labels.closed && <> · <span className="sm-warn">{labels.closed - labels.labelled} still to label</span></>}
    </p>
    <div className="sm-extremes">
      <Extreme title="Best trade" trade={day.best} />
      <Extreme title="Worst trade" trade={day.worst} />
    </div>
    {parts.length > 0 && <section className="sm-note" aria-label="The day's note" data-testid="day-note">
      {parts.map(part => <div key={part.key}><h5>{part.title}</h5><p>{part.text}</p></div>)}
    </section>}
  </div>
}

function Extreme({ title, trade }: { title: string; trade: SummaryTrade | null }) {
  if (!trade) return <div className="sm-extreme empty"><h5>{title}</h5><p className="sm-muted">None</p></div>
  return <div className="sm-extreme"><h5>{title}</h5>
    <p><strong className={tone(trade.net_pnl)}>{money(trade.net_pnl)}</strong> <span className={tone(trade.pnl_pct)}>({percent(trade.pnl_pct)})</span></p>
    <p className="sm-muted">{tradeName(trade)}{trade.exit_time ? ` · ${clock(trade.entry_time)}–${clock(trade.exit_time)}` : ''}{trade.strategy ? ` · ${trade.strategy}` : ''}</p>
  </div>
}

/** The Day P&L Journey of every mode of the day (replay, paper and real keep their own capital). */
export function DayJourneys({ day }: { day: SummaryDay }) {
  if (!day.journeys.length) return <p className="sm-muted">No completed trades to draw.</p>
  return <div className="sm-journeys">{day.journeys.map(journey =>
    <DayJourneyChart key={journey.id} journey={journey} title={day.journeys.length > 1 ? `Day P&L journey · ${modeName(journey.mode)}` : 'Day P&L journey'} />)}</div>
}

/**
 * The day's charts: the daily-scale chart of the symbol, then the day chart (a tab per symbol, Underlying and CE / PE, with the
 * markers and the drawings and texts made in the day's Notes), read only. Mounted only when wanted, so a closed card costs nothing.
 */
export function DayCharts({ day, symbol, onSymbolChange }: { day: SummaryDay; symbol?: string; onSymbolChange?: (symbol: string) => void }) {
  const [own, setOwn] = useState('')
  const chosen = chartSymbol(day, symbol ?? own)
  return <div className="sm-charts">
    <DailyChart symbol={chosen} date={day.date} />
    <DayChart date={day.date} readOnly symbol={chosen} onSymbolChange={next => { setOwn(next); onSymbolChange?.(next) }} />
  </div>
}

/** A day as a card of the list: header, journey beside the figures, and the charts when the card is opened. */
export default function SummaryDayCard({ day, onDeck }: { day: SummaryDay; onDeck?: (date: string) => void }) {
  const [open, setOpen] = useState(false)
  return <article className="sm-card" aria-label={`Summary of ${day.date}`} data-testid="summary-card" data-date={day.date}>
    <header className="sm-card-head">
      <h3>{longDate(day.date)}</h3>
      <span className="sm-symbols">{day.symbols.map(symbol => <span key={symbol.symbol} className="sm-chip" title={`${symbol.trades} closed trades · ${symbol.modes.map(modeName).join(', ')}`}>{symbol.symbol}</span>)}</span>
      {day.scores.map(row => <span key={row.mode} className="sm-score">{day.scores.length > 1 && <span className="sm-muted">{scoreModeName(row.mode)}</span>}<DayScoreBadge score={row} /></span>)}
      {!day.scores.length && <span className="sm-muted" title="Open the day's Notes tab to score it">no score yet</span>}
      <span className="sm-spacer" />
      {onDeck && <button type="button" onClick={() => onDeck(day.date)}>Open in deck</button>}
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide charts' : 'Show charts'}</button>
    </header>
    <div className="sm-card-body">
      <DayFigures day={day} />
      <DayJourneys day={day} />
    </div>
    {open && <DayCharts day={day} />}
  </article>
}

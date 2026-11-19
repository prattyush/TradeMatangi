import { useMemo, useRef, useState, type ReactNode } from 'react'
import { friendlyError } from './errors'
import { lastPickableDay, monthOf, todayIso, type MonthRef } from '../calendar'
import { dayMarksByDate, formatDay, removalImpact, sideLabel, toDiveSetup, withSetups } from '../model'
import type { Dive, DiveSetup, Side } from '../types'
import DiveCalendar from './DiveCalendar'
import { useDeepDiveHost } from './host'
import { useFillWindow } from './useFillWindow'
import { symbolChoices } from '../symbols'
import { MARK_VIEWS, optionEligible, type MarkView } from './inDepthModel'
import { usePreviewStrikes } from './usePreviewStrikes'

interface Props {
  dive: Dive
  setDive: (update: (dive: Dive) => Dive) => void
  symbol: string
  onSymbol: (symbol: string) => void
}

/**
 * Step 1 of a deep dive: mark on a calendar the days the strategy occurred, as a Buy setup, a Sell setup or both. The chart
 * beside the calendar shows the selected day so each mark can be checked against the price action. Every click saves.
 */
export default function DateMarking({ dive, setDive, symbol, onSymbol }: Props) {
  const { api, settings, Chart } = useDeepDiveHost()
  const today = todayIso()
  const latest = dive.setups.filter(s => s.symbol === symbol).slice(-1)[0]?.date ?? null
  const [month, setMonth] = useState<MonthRef>(() => monthOf(latest ?? lastPickableDay(today)))
  const [selected, setSelected] = useState<string | null>(latest)
  const [busy, setBusy] = useState<string | null>(null)
  // The calendar and the chart run to the bottom of the window; the calendar and the list of days beside the chart scroll on their own
  // when they are taller, so the chart is always inside the window.
  const row = useRef<HTMLDivElement>(null)
  useFillWindow(row, { minHeight: 480 })
  const [view, setView] = useState<MarkView>('underlying')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<DiveSetup | null>(null)
  const ref = { category: dive.category, strategy: dive.strategy }
  const readOnly = !dive.can_edit
  const forSymbol = useMemo(() => dive.setups.filter(s => s.symbol === symbol), [dive.setups, symbol])
  const marks = useMemo(() => dayMarksByDate(forSymbol), [forSymbol])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await action() } catch (e) { setError(friendlyError(e)) } finally { setBusy(null) }
  }
  const add = (date: string, side: Side) => run(`${date}|${side}`, async () => {
    const saved = await api.saveSetup({ ...ref, symbol, date, side })
    setDive(current => withSetups(current, [...current.setups, toDiveSetup(saved, current.tags)]))
    setSelected(date)
  })
  const remove = (setup: DiveSetup) => run(`${setup.date}|${setup.side}`, async () => {
    await api.deleteSetup(setup)
    setDive(current => withSetups(current, current.setups.filter(s => !(s.date === setup.date && s.side === setup.side && s.symbol === setup.symbol))))
    setPending(null)
  })
  const toggle = (date: string, side: Side) => {
    const existing = forSymbol.find(s => s.date === date && s.side === side)
    if (!existing) void add(date, side)
    else if (removalImpact(existing).hasData) setPending(existing)
    else void remove(existing)
  }
  const select = (date: string) => { setSelected(date); setMonth(monthOf(date)) }
  const impact = pending ? removalImpact(pending) : null
  const sides = (date: string) => (['buy', 'sell'] as const).filter(side => marks.get(date)?.[side]).map(sideLabel).join(' + ')

  return <div className="dd-mark" ref={row}>
    <div className="dd-mark-left">
      <div className="pl-bar">
        <label>Symbol <select value={symbol} onChange={e => onSymbol(e.target.value)} aria-label="Symbol">
          {symbolChoices(symbol).map(choice => <option key={choice.symbol} value={choice.symbol}>{choice.label}</option>)}</select></label>
        <span className="pl-muted">{forSymbol.length} marked {forSymbol.length === 1 ? 'day' : 'days'}</span>
      </div>
      {readOnly && <p className="pl-muted" role="status">This deep dive was shared with you: you can look at it but not change it.</p>}
      {error && <p className="pl-error" role="alert">{error}</p>}
      <DiveCalendar month={month} onMonthChange={setMonth} today={today} marks={marks} selected={selected} onSelect={select} onToggle={toggle} readOnly={readOnly} busy={busy} />
      <p className="pl-muted dd-legend"><b>B</b> marks a Buy setup (long / bullish), <b>S</b> a Sell setup (short / bearish); click the day number to see its chart.</p>
      {pending && impact && <div className="dd-confirm" role="alertdialog" aria-label="Remove marked day">
        <p>Remove the {sideLabel(pending.side)} setup on {formatDay(pending.date)}? It has {impact.tagMarks} tag {impact.tagMarks === 1 ? 'mark' : 'marks'}, {impact.chartMarks} chart {impact.chartMarks === 1 ? 'mark' : 'marks'}{impact.hasOutcome ? ', an outcome' : ''}{impact.hasNotes ? ' and notes' : ''}. This cannot be undone.</p>
        <div className="pl-bar"><button className="pl-danger" onClick={() => void remove(pending)}>Remove</button><button onClick={() => setPending(null)}>Keep</button></div>
      </div>}
      <h4>Marked days</h4>
      {dive.setups.length === 0 ? <p className="pl-muted">Nothing marked yet. Use B or S on the days this strategy occurred.</p> : <ul className="dd-days">
        {dive.setups.map(setup => <li key={`${setup.date}|${setup.symbol}|${setup.side}`} className={selected === setup.date && setup.symbol === symbol ? 'active' : ''}>
          <button className="dd-day-link" onClick={() => { onSymbol(setup.symbol); select(setup.date) }}>{formatDay(setup.date)}</button>
          <span className={`dd-side-tag ${setup.side}`}>{sideLabel(setup.side)}</span>
          <span className="pl-muted">{setup.symbol}</span>
          {!readOnly && <button className="dd-x" aria-label={`Remove ${sideLabel(setup.side)} on ${formatDay(setup.date)}`} disabled={busy !== null}
            onClick={() => { if (removalImpact(setup).hasData) setPending(setup); else void remove(setup) }}>✕</button>}
        </li>)}
      </ul>}
    </div>
    <div className="dd-mark-right">
      {selected ? <>
        <p className="pl-muted">{symbol} · {formatDay(selected)}{sides(selected) ? ` · marked ${sides(selected)}` : ' · not marked'}</p>
        {optionEligible(symbol) && <div className="pl-bar dd-view" role="tablist" aria-label="Chart to look at">
          {MARK_VIEWS.map(choice => <button key={choice.view} role="tab" aria-selected={view === choice.view} aria-pressed={view === choice.view}
            title={choice.view === 'underlying' ? 'The underlying chart of the day' : `The ${choice.view} of the day (strike from the 09:30 price, premium at most 75), only to get an idea of the option chart`}
            onClick={() => setView(choice.view)}>{choice.label}</button>)}
        </div>}
        <FilledChart>{view === 'underlying' || !optionEligible(symbol)
          ? <Chart key={`${symbol}-${selected}`} symbol={symbol} date={selected} title={`${symbol} · ${formatDay(selected)}`} historicalDays={settings.historicalDays} />
          : <OptionPreview symbol={symbol} date={selected} right={view} />}</FilledChart>
      </> : <p className="pl-muted dd-empty">Select a day to see its chart.</p>}
    </div>
  </div>
}

/** The CE or PE of a day on Mark days: the strike of the 09:30 pick (premium at most 75), shown only to get an idea of the option chart. */
function OptionPreview({ symbol, date, right }: { symbol: string; date: string; right: 'CE' | 'PE' }) {
  const { settings, Chart } = useDeepDiveHost()
  const preview = usePreviewStrikes(symbol, date)
  if (preview.state === 'error') return <p className="pl-error" role="alert">Could not pick the {right} strike: {preview.error}</p>
  if (preview.state !== 'ready') return <p className="pl-muted dd-empty">Picking the {right} strike…</p>
  const strike = right === 'CE' ? preview.ce : preview.pe
  return <Chart key={`${symbol}-${date}-${right}-${strike}`} symbol={symbol} date={date} title={`${symbol} ${right} ${strike} · ${formatDay(date)}`}
    strike={strike} right={right} expiry={preview.expiry} historicalDays={settings.historicalDays} />
}

/**
 * The day's chart, running from where it starts to the bottom of the window. The KLine chart does not fit a box that only a flex
 * rule sizes (with many marked days beside it the box ran past the window and its time axis fell out of view), so it is given an
 * explicit height, as in the in-depth step; a narrow window is left to the stylesheet.
 */
function FilledChart({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useFillWindow(box, { minHeight: 360 })
  return <div className="dd-chart" ref={box}>{children}</div>
}


import { useEffect, useMemo, useRef, useState } from 'react'
import DayScoreBadge from '../dayScore/DayScoreBadge'
import { scoreModeName } from '../dayScore/model'
import { DayCharts, DayFigures, DayJourneys } from './SummaryDay'
import { chronological, deckStep, longDate, money, percent, scoreWords, shortDate, stripTone, tone } from './summaryModel'
import type { SummaryDay } from './types'

/** Keys that belong to a field or a control, not to the deck. */
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * The Summary as a deck: one day at a time, oldest to newest, with the day's charts large (the drawings and texts made in its Notes)
 * and its figures beside them. Previous / Next, the arrow keys and a strip of days move through it; the symbol tab you are on stays
 * while you step. Nothing is saved: the deck is only a way to read the days one after another.
 */
export default function SummaryDeck({ days, start, onList }: { days: readonly SummaryDay[]; start?: string; onList: () => void }) {
  const ordered = useMemo(() => chronological(days), [days])
  const [index, setIndex] = useState(() => { const found = ordered.findIndex(day => day.date === start); return found >= 0 ? found : Math.max(0, ordered.length - 1) })
  const [symbol, setSymbol] = useState('')
  const root = useRef<HTMLDivElement>(null)
  // The deck keeps the day it is on when the filter's result changes under it; otherwise it lands on the newest day.
  const current = ordered[Math.min(index, ordered.length - 1)]
  const dateRef = useRef(current?.date)
  dateRef.current = current?.date
  useEffect(() => {
    const found = ordered.findIndex(day => day.date === dateRef.current)
    setIndex(found >= 0 ? found : Math.max(0, ordered.length - 1))
  }, [ordered])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editable(event.target) || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'Escape') { onList(); return }
      const next = deckStep(event.key, index, ordered.length)
      if (next === null) return
      event.preventDefault()
      setIndex(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, ordered.length, onList])
  useEffect(() => { root.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' }) }, [index])
  if (!current) return <p className="sm-muted" role="status">No days to show.</p>
  const position = Math.min(index, ordered.length - 1)
  return <div className="sm-deck" ref={root} data-testid="summary-deck" aria-label="Summary deck">
    <div className="sm-deck-bar">
      <button type="button" onClick={() => setIndex(position - 1)} disabled={position === 0} aria-label="Previous day">‹ Previous</button>
      <div className="sm-deck-title">
        <h3 data-testid="deck-date">{longDate(current.date)}</h3>
        <span className="sm-muted">Day {position + 1} of {ordered.length}</span>
      </div>
      {current.scores.map(row => <span key={row.mode} className="sm-score">{current.scores.length > 1 && <span className="sm-muted">{scoreModeName(row.mode)}</span>}<DayScoreBadge score={row} /></span>)}
      <span className={`sm-deck-pnl ${tone(current.totals.net_pnl)}`}>{money(current.totals.net_pnl)} <small>{percent(current.totals.pnl_pct)}</small></span>
      <span className="sm-spacer" />
      <button type="button" onClick={onList}>Back to list</button>
      <button type="button" onClick={() => setIndex(position + 1)} disabled={position >= ordered.length - 1} aria-label="Next day">Next ›</button>
    </div>
    <div className="sm-strip" role="group" aria-label="Days">
      {ordered.map((day, at) => <button key={day.date} type="button" className={`sm-dot ${stripTone(day)}`} aria-current={at === position} aria-label={`${day.date}${day.scores.length ? `, score ${scoreWords(day)}` : ''}, ${money(day.totals.net_pnl)}`}
        title={`${shortDate(day.date)} · ${money(day.totals.net_pnl)}${day.scores.length ? ` · score ${scoreWords(day)}` : ''}`} onClick={() => setIndex(at)}>{Number(day.date.slice(8))}</button>)}
    </div>
    <div className="sm-deck-page" key={current.date}>
      <div className="sm-deck-main"><DayCharts day={current} symbol={symbol} onSymbolChange={setSymbol} /></div>
      <aside className="sm-deck-side"><DayJourneys day={current} /><DayFigures day={current} /></aside>
    </div>
  </div>
}

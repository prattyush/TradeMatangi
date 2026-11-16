import { lastPickableDay, monthGrid, monthLabel, monthOf, pickableDay, shiftMonth, type MonthRef } from '../../../../shared/deepdive/calendar'
import type { DayMarks } from '../../../../shared/deepdive/model'
import type { Side } from '../../../../shared/deepdive/types'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Props {
  month: MonthRef
  onMonthChange: (month: MonthRef) => void
  today: string
  marks: Map<string, DayMarks>
  selected: string | null
  onSelect: (date: string) => void
  onToggle: (date: string, side: Side) => void
  readOnly?: boolean
  /** `date|side` of a save in flight: that button waits. */
  busy?: string | null
}

/**
 * A month of weekdays. A day's number selects it (the chart beside shows it); its B and S buttons mark a Buy or a Sell
 * setup, independently, so one stray click can never swap a side. Weekends, today and later days cannot hold a setup.
 */
export default function DiveCalendar({ month, onMonthChange, today, marks, selected, onSelect, onToggle, readOnly, busy }: Props) {
  const weeks = monthGrid(month)
  return <div className="dd-cal">
    <div className="dd-cal-head">
      <button onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
      <strong aria-live="polite">{monthLabel(month)}</strong>
      <button onClick={() => onMonthChange(shiftMonth(month, 1))} aria-label="Next month">›</button>
      <button onClick={() => onMonthChange(monthOf(lastPickableDay(today)))} title="Jump to the latest trading day">Latest</button>
    </div>
    <div className="dd-cal-grid" role="grid" aria-label={`Days of ${monthLabel(month)}`}>
      {WEEKDAYS.map(name => <div key={name} className="dd-cal-dow" role="columnheader">{name}</div>)}
      {weeks.flat().map(cell => {
        const pickable = cell.inMonth && pickableDay(cell.date, today)
        const day = marks.get(cell.date) ?? { buy: false, sell: false }
        const classes = ['dd-cal-cell', pickable ? 'pickable' : 'off', day.buy || day.sell ? 'marked' : '', selected === cell.date ? 'selected' : ''].filter(Boolean).join(' ')
        return <div key={cell.date} className={classes} role="gridcell" hidden={!cell.inMonth}>
          <button className="dd-cal-day" disabled={!pickable} aria-pressed={selected === cell.date} onClick={() => onSelect(cell.date)}
            aria-label={`${cell.date}${day.buy ? ', Buy setup' : ''}${day.sell ? ', Sell setup' : ''}`}>{cell.day}</button>
          {pickable && <span className="dd-cal-sides">
            {(['buy', 'sell'] as const).map(side => <button key={side} className={`dd-side ${side}`} aria-pressed={day[side]}
              disabled={readOnly || busy === `${cell.date}|${side}`} title={side === 'buy' ? 'Buy setup (long / bullish) on this day' : 'Sell setup (short / bearish) on this day'}
              onClick={() => onToggle(cell.date, side)}>{side === 'buy' ? 'B' : 'S'}</button>)}
          </span>}
        </div>
      })}
    </div>
  </div>
}

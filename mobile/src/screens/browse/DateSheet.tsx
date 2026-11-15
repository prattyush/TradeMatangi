import { useState } from 'react'
import { Sheet } from '../../shell/Sheet'
import { formatBrowseDate, isWeekday } from './browseModel'

/** Pick a day: the phone's date picker, with a hint for weekends. Nothing changes until Show. */
export function DateSheet({ date, latest, onPick, onClose }: { date: string; latest: string; onPick: (date: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(date)
  const weekend = draft !== '' && !isWeekday(draft)
  return (
    <Sheet title="Day" onClose={onClose}>
      <label>
        Date
        <input type="date" value={draft} max={latest} onChange={event => setDraft(event.target.value)} />
      </label>
      {weekend && <div className="form-error" role="alert">{formatBrowseDate(draft)} is a weekend: the market is closed.</div>}
      <p className="muted">The chart shows this day and the days before it. Days with no data (exchange holidays) say so.</p>
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={() => onPick(latest)}>Latest day</button>
        <button type="button" className="btn btn-primary" disabled={!draft || weekend || draft > latest} onClick={() => onPick(draft)}>Show</button>
      </div>
    </Sheet>
  )
}

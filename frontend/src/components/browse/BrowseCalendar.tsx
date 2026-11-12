import { useState } from 'react'
import { monthGrid, pickableDay, shiftMonth } from '../../services/browseWorkspace'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const button: React.CSSProperties = { background: '#21262d', border: '1px solid #30363d', color: '#e5e7eb', borderRadius: 5, padding: '3px 8px', fontSize: 12, cursor: 'pointer' }

/**
 * A month calendar for the pane's day. The arrows only move between months; nothing is chosen (and nothing reloads) until a
 * day is clicked. (The browser's own date box applies a date at every month arrow, which reloads the chart each time.)
 */
export function BrowseCalendar({ selected, latest, onPick }: { selected: string; latest: string; onPick: (iso: string) => void }) {
  const initial = new Date(`${selected}T00:00:00Z`)
  const [shown, setShown] = useState({ year: initial.getUTCFullYear(), month: initial.getUTCMonth() })
  const title = new Date(Date.UTC(shown.year, shown.month, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const latestDate = new Date(`${latest}T00:00:00Z`)
  const nextOk = shown.year * 12 + shown.month < latestDate.getUTCFullYear() * 12 + latestDate.getUTCMonth()
  return (
    <div role="group" aria-label="Choose a day" style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button type="button" style={button} aria-label="Previous month" onClick={() => setShown(value => shiftMonth(value.year, value.month, -1))}>‹</button>
        <strong aria-live="polite">{title}</strong>
        <button type="button" style={button} aria-label="Next month" disabled={!nextOk} onClick={() => setShown(value => shiftMonth(value.year, value.month, 1))}>›</button>
      </div>
      <table role="grid" style={{ borderCollapse: 'collapse', width: '100%', textAlign: 'center' }}>
        <thead><tr>{WEEKDAYS.map(day => <th key={day} scope="col" style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, padding: 2 }}>{day}</th>)}</tr></thead>
        <tbody>
          {monthGrid(shown.year, shown.month).map((week, row) => (
            <tr key={row}>
              {week.map((iso, column) => {
                if (!iso) return <td key={column} />
                const label = new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
                const enabled = pickableDay(iso, latest)
                const chosen = iso === selected
                return (
                  <td key={column} style={{ padding: 1 }}>
                    <button type="button" aria-label={label} aria-pressed={chosen} disabled={!enabled} onClick={() => onPick(iso)}
                      style={{ ...button, width: '100%', padding: '4px 0', background: chosen ? '#1f6feb' : '#21262d', borderColor: chosen ? '#1f6feb' : '#30363d', color: chosen ? '#fff' : enabled ? '#e5e7eb' : '#4b5563', cursor: enabled ? 'pointer' : 'default' }}>
                      {Number(iso.slice(8))}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

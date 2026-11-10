import { useState } from 'react'
import { fmtHHMM, type PnlDisplayMode } from '../labeling/model'
import { TONE_COLORS } from './exitMethods'
import { holdingText, signedMoney, signedPct, type WalkthroughLeg, type WalkthroughTrip } from './walkthroughModel'
import './walkthrough.css'

const tone = (value: number | null | undefined) => (value == null || value === 0 ? '' : value > 0 ? 'up' : 'down')
const number = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const pctText = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}%`)

function Chip({ leg }: { leg: WalkthroughLeg }) {
  const color = TONE_COLORS[leg.method.tone]
  return <span className="wt-chip" style={{ color: color.fg, background: color.bg }} title={leg.method.name}>{leg.method.code}</span>
}

/** One row per entry or exit; the arrow opens the rest of what is known about it. */
function LegRows({ title, legs, role }: { title: string; legs: WalkthroughLeg[]; role: 'entry' | 'exit' }) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  if (!legs.length) return <section className="wt-block" aria-label={title}><h4>{title}</h4><p className="wt-muted">{role === 'exit' ? 'Still open: no exit yet.' : 'None.'}</p></section>
  const toggle = (index: number) => setOpen(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })
  return (
    <section className="wt-block" aria-label={title}>
      <h4>{title}</h4>
      <table className="wt-table">
        <thead><tr><th>Time</th><th className="num">Size</th><th className="num">Price</th><th className="num">Capital</th>{role === 'entry' && <th className="num">Risk</th>}<th>How</th><th /></tr></thead>
        <tbody>
          {legs.map((leg, index) => {
            const hasMore = leg.details.length > 0 || leg.method.tone === 'unknown'
            return [
              <tr key={`${role}-${index}`} className={`wt-leg ${leg.side === 'BUY' ? 'buy' : 'sell'}`}>
                <td>{fmtHHMM(leg.time)}</td>
                <td className="num">{leg.side === 'BUY' ? 'B' : 'S'} {number(leg.quantity)}</td>
                <td className="num">{number(leg.price)}</td>
                <td className="num">{pctText(leg.capitalPct)}</td>
                {role === 'entry' && <td className="num">{pctText(leg.riskPct)}</td>}
                <td><Chip leg={leg} /></td>
                <td>{hasMore && <button type="button" className="wt-more" aria-expanded={open.has(index)} aria-label={`More info on ${role} ${index + 1}`} onClick={() => toggle(index)}>{open.has(index) ? '▾' : '▸'}</button>}</td>
              </tr>,
              open.has(index) && (
                <tr key={`${role}-${index}-more`} className="wt-extra"><td colSpan={role === 'entry' ? 7 : 6}>
                  <strong>{leg.method.name}</strong>
                  {leg.details.map(([label, text]) => <span key={label}> · {label}: {text}</span>)}
                </td></tr>
              ),
            ]
          })}
        </tbody>
      </table>
    </section>
  )
}

/** The right-hand panel of Trade Walkthrough: the day's P&L before and after, then the entries and exits of one round trip. */
export default function WalkthroughPanel({ trip, pnlMode }: { trip: WalkthroughTrip; pnlMode?: PnlDisplayMode }) {
  const percent = pnlMode === 'percent'
  const main = (money: number | null, pct: number | null) => (percent ? signedPct(pct) : signedMoney(money))
  const sub = (money: number | null, pct: number | null) => (percent ? signedMoney(money) : signedPct(pct))
  const fee = trip.feeSource === 'estimated' || trip.feeSource === 'estimated_history_changed' ? 'estimated' : trip.feeSource === 'allocated_actual' ? 'actual (allocated)' : trip.feeSource === 'mixed' ? 'part actual' : null
  return (
    <div className="wt-panel">
      <section className="wt-story" aria-label="Day P&L story">
        <div className="wt-step" aria-label="Day before">
          <small>Day before</small>
          <strong className={tone(trip.before?.pnl)}>{trip.before ? main(trip.before.pnl, trip.before.pnlPct) : '—'}</strong>
          <small>{trip.before ? sub(trip.before.pnl, trip.before.pnlPct) : ''}</small>
        </div>
        <span className="wt-arrow" aria-hidden="true">→</span>
        <div className="wt-step wt-this" aria-label="This trade">
          <small>This trade</small>
          <strong className={tone(trip.pnl)}>{main(trip.pnl, trip.pnlPct)}</strong>
          <small>{sub(trip.pnl, trip.pnlPct)}</small>
        </div>
        <span className="wt-arrow" aria-hidden="true">→</span>
        <div className="wt-step" aria-label="Day after">
          <small>Day after</small>
          <strong className={tone(trip.after?.pnl)}>{trip.after ? main(trip.after.pnl, trip.after.pnlPct) : '—'}</strong>
          <small>{trip.after ? sub(trip.after.pnl, trip.after.pnlPct) : ''}</small>
        </div>
      </section>
      <div className="wt-facts" role="group" aria-label="Trade facts">
        <span title="The most capital this trade had in use at any one time, as % of the session capital"><b>Peak capital</b> {pctText(trip.peakCapitalPct)}</span>
        <span><b>Held</b> {holdingText(trip.holdingSeconds)}</span>
        {trip.direction && <span><b>{trip.direction === 'LONG' ? 'Long' : 'Short'}</b> {trip.contract}</span>}
        {trip.fees !== null && <span title="Charges counted in this trade's P&L"><b>Charges</b> ₹{number(trip.fees)}{fee ? ` (${fee})` : ''}</span>}
      </div>
      <LegRows title="Entries" legs={trip.entries} role="entry" />
      <LegRows title="Exits" legs={trip.exits} role="exit" />
      <div className="wt-notes">
        {!trip.detailed && <p role="note">This server did not send the entry and exit details for this trade, so only times, sizes and prices are shown.</p>}
        {trip.sameSecond && <p role="note">Other trades closed in the same second, so the order of the day's P&L around this trade is approximate.</p>}
        <p className="wt-muted">The day's P&L counts realised trades only, in the order they closed.</p>
      </div>
    </div>
  )
}

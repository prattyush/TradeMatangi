import { useEffect, useState, type ReactNode } from 'react'
import type { PnlDisplayMode } from '../labeling/model'
import { clock24, signedMoney, signedPct } from '../walkthrough/walkthroughModel'
import { legKey, type DayResult, type LegEdit, type LegResult, type TripResult } from './whatIfModel'
import './whatif.css'

const tone = (value: number | null | undefined) => (value == null || Math.abs(value) < 0.005 ? '' : value > 0 ? 'up' : 'down')
const pct = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}%`)

/** A number box that keeps what is being typed ("12.") and follows the value when it changes elsewhere (a chart pick, a reset). */
function NumberField({ value, onCommit, label, step, integer = false }: { value: number; onCommit: (value: number) => void; label: string; step: string; integer?: boolean }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { if (Number(text) !== value || text.trim() === '') setText(String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className="wi-input" type="number" inputMode={integer ? 'numeric' : 'decimal'} step={step} min={integer ? 0 : 0.01} aria-label={label} value={text}
      onChange={event => {
        setText(event.target.value)
        const parsed = Number(event.target.value)
        if (event.target.value.trim() !== '' && Number.isFinite(parsed) && (integer ? parsed >= 0 : parsed > 0)) onCommit(integer ? Math.round(parsed) : parsed)
      }}
      onBlur={() => { const parsed = Number(text); if (text.trim() === '' || !Number.isFinite(parsed) || (integer ? parsed < 0 : parsed <= 0)) setText(String(value)) }} />
  )
}

function Figures({ title, before, after, pctBefore, pctAfter, delta, deltaPct, mode, strong = false }: {
  title: string; before: number; after: number; pctBefore: number | null; pctAfter: number | null; delta: number; deltaPct: number | null; mode?: PnlDisplayMode; strong?: boolean
}) {
  const percent = mode === 'percent'
  const main = (money: number, p: number | null) => (percent ? signedPct(p) : signedMoney(money))
  const sub = (money: number, p: number | null) => (percent ? signedMoney(money) : signedPct(p))
  return (
    <section className={`wi-figures${strong ? ' wi-day' : ''}`} aria-label={title}>
      <div className="wi-step" aria-label={`${title}: actual`}><small>{title} · actual</small><strong className={tone(before)}>{main(before, pctBefore)}</strong><small>{sub(before, pctBefore)}</small></div>
      <span className="wi-arrow" aria-hidden="true">→</span>
      <div className="wi-step wi-this" aria-label={`${title}: what-if`}><small>What-if</small><strong className={tone(after)}>{main(after, pctAfter)}</strong><small>{sub(after, pctAfter)}</small></div>
      <div className="wi-step wi-delta" aria-label={`${title}: difference`}><small>Difference</small><strong className={tone(delta)}>{main(delta, deltaPct)}</strong><small>{sub(delta, deltaPct)}</small></div>
    </section>
  )
}

function LegRow({ leg, picking, canPick, onEdit, onPick }: { leg: LegResult; picking: boolean; canPick: boolean; onEdit: (edit: LegEdit | null) => void; onPick: () => void }) {
  const what = `${leg.fill.role} at ${clock24(leg.fill.time)}`
  const capitalChange = leg.capitalPct !== null && leg.originalCapitalPct !== null ? leg.capitalPct - leg.originalCapitalPct : null
  return (
    <tr className={`wi-leg ${leg.fill.side === 'BUY' ? 'buy' : 'sell'}${leg.changed ? ' changed' : ''}${leg.removed ? ' removed' : ''}`}>
      <td>{clock24(leg.fill.time)}</td>
      <td className="wi-side">{leg.fill.role === 'entry' ? 'In' : 'Out'} {leg.fill.side === 'BUY' ? 'B' : 'S'}</td>
      <td><NumberField value={leg.price} step="0.05" label={`Price of ${what}`} onCommit={price => onEdit({ price, quantity: leg.quantity })} /></td>
      <td><NumberField value={leg.quantity} step="1" integer label={`Quantity of ${what}`} onCommit={quantity => onEdit({ price: leg.price, quantity })} /></td>
      <td className="num">
        {leg.removed ? <span className="wi-removed">removed</span> : <>{pct(leg.capitalPct)}{capitalChange !== null && Math.abs(capitalChange) >= 0.005 && <small className={capitalChange > 0 ? 'down' : 'up'}> {capitalChange > 0 ? '+' : '−'}{Math.abs(capitalChange).toFixed(2)}</small>}</>}
      </td>
      <td className="wi-actions">
        {canPick && <button type="button" className={`wi-tool${picking ? ' on' : ''}`} aria-pressed={picking} aria-label={`Pick the price of ${what} on the chart`} title="Click the chart to set this price" onClick={onPick}>⌖</button>}
        {leg.changed && <button type="button" className="wi-tool" aria-label={`Reset ${what}`} title="Back to the real fill" onClick={() => onEdit(null)}>↺</button>}
      </td>
    </tr>
  )
}

/** The right-hand panel of What If: the day and the trade, actual against what-if, and the trade's fills to edit. */
export default function WhatIfPanel({ result, day, pnlMode, canPick, picking, onEdit, onPick, onResetTrip, header }: {
  result: TripResult | undefined
  day: DayResult
  pnlMode?: PnlDisplayMode
  canPick: boolean
  /** The `legKey` of the fill whose price is being picked on the chart. */
  picking: string | null
  onEdit: (fillKey: string, edit: LegEdit | null) => void
  onPick: (fillKey: string | null) => void
  onResetTrip: () => void
  header?: ReactNode
}) {
  const entries = result?.legs.filter(leg => leg.fill.role === 'entry') ?? []
  const exits = result?.legs.filter(leg => leg.fill.role === 'exit') ?? []
  const table = (title: string, legs: LegResult[]) => legs.length > 0 && (
    <section className="wi-block" aria-label={title}>
      <h4>{title}</h4>
      <table className="wi-table">
        <thead><tr><th>Time</th><th /><th>Price</th><th>Qty</th><th className="num">Capital</th><th /></tr></thead>
        <tbody>
          {legs.map(leg => {
            const key = legKey(leg.fill)
            return <LegRow key={key} leg={leg} picking={picking === key} canPick={canPick} onEdit={edit => onEdit(key, edit)} onPick={() => onPick(picking === key ? null : key)} />
          })}
        </tbody>
      </table>
    </section>
  )
  return (
    <div className="wi-panel">
      {header}
      <Figures title="Day" strong before={day.actual} after={day.whatif} pctBefore={day.actualPct} pctAfter={day.whatifPct} delta={day.delta} deltaPct={day.deltaPct} mode={pnlMode} />
      <div className="wi-facts" role="group" aria-label="What-if summary">
        <span><b>{day.tripsEdited}</b> {day.tripsEdited === 1 ? 'trade' : 'trades'} edited</span>
        {day.warnings > 0 && <span className="wi-warn-count">{day.warnings} with a warning</span>}
      </div>
      {result ? (
        <>
          <Figures title="This trade" before={result.actualPnl} after={result.pnl} pctBefore={result.actualPnlPct} pctAfter={result.pnlPct} delta={result.delta} deltaPct={result.pnlPct !== null && result.actualPnlPct !== null ? result.pnlPct - result.actualPnlPct : null} mode={pnlMode} />
          <div className="wi-facts" role="group" aria-label="Trade facts">
            <span title="The most capital this trade had in use at any one time, as % of the session capital"><b>Peak capital</b> {pct(result.actualPeakCapitalPct)}{result.edited && result.peakCapitalPct !== result.actualPeakCapitalPct ? ` → ${pct(result.peakCapitalPct)}` : ''}</span>
            <span><b>Entries</b> {result.entryQuantity} <b>Exits</b> {result.exitQuantity}</span>
            <button type="button" className="wi-link" disabled={!result.edited} onClick={onResetTrip}>Reset this trade</button>
          </div>
          {table('Entries', entries)}
          {table('Exits', exits)}
          {result.warnings.length > 0 && <div className="wi-warnings" role="alert">{result.warnings.map(text => <p key={text}>{text}</p>)}</div>}
        </>
      ) : (
        <p className="wi-note" role="note">This server did not send the fills of this trade, so it cannot be edited here.</p>
      )}
      <p className="wi-muted">A what-if only changes the numbers you see here. It never places or changes an order, and the real trade stays as it was.</p>
    </div>
  )
}

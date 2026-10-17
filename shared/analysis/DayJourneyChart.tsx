import { useState } from 'react'
import type { JourneyCurve, JourneyPoint, JourneyMember } from './dayJourney'
import './dayJourney.css'
const money=(value:number)=>`₹${value.toLocaleString('en-IN',{maximumFractionDigits:2})}`
export default function DayJourneyChart({journey,title='Day P&L journey',onSelect}:{journey:JourneyCurve;title?:string;onSelect?:(identity:JourneyMember)=>void}) {
  const [requestedUnit,setUnit]=useState('pct')
  const [selected,setSelected]=useState<JourneyPoint|null>(null)
  const unit=requestedUnit==='pct'&&journey.capital!=null?'pct':'money'
  const format=(value:number)=>unit==='pct'?`${value.toFixed(2)}%`:money(value)
  const axisFormat=(v:number)=>unit==='pct'?format(v):`₹${new Intl.NumberFormat('en-IN',{notation:'compact',maximumFractionDigits:1}).format(v)}`
  const value=(p:JourneyPoint)=>unit==='pct'?p.pnl_pct!:p.pnl
  const low=Math.min(0,...journey.points.map(value)),high=Math.max(unit==='pct'?0.01:1,...journey.points.map(value))
  const x=(index:number)=>64+index/Math.max(1,journey.points.length)*510
  const y=(pnl:number)=>192-(pnl-low)/(high-low)*154
  const current=selected&&journey.points.find(p=>p.cycle_id===selected.cycle_id&&p.session_id===selected.session_id)
  const inspect=(p:JourneyPoint)=>setSelected(p)
  let tradeCount=0
  const tradeNumbers=journey.points.map(p=>{const start=tradeCount+1;tradeCount+=p.members.length;return start})
  return <section className="day-journey" aria-label={title}>
    <header><h3>{title}</h3><select aria-label={`${title} units`} value={unit} onChange={e=>setUnit(e.target.value)}><option value="pct" disabled={journey.capital==null}>%</option><option value="money">₹</option></select></header>
    <p>{journey.capital==null?'Percentage unavailable: starting capital missing.':`${journey.sessions>1?'Average session':'Starting session'} capital ${money(journey.capital)}${journey.sessions>1?` · ${journey.sessions} sessions`:''}`}</p>
    {journey.points.length>0?<svg viewBox="0 0 610 225" role="img" aria-label="Cumulative completed-trade net P&L">
      {[low,(low+high)/2,high].map((v,i)=><g key={i}><line x1="64" x2="580" y1={y(v)} y2={y(v)} stroke="#29384c"/><text x="59" y={y(v)+4} textAnchor="end" fill="#94a3b8" fontSize="11">{axisFormat(v)}</text></g>)}
      <line x1="64" x2="580" y1={y(0)} y2={y(0)} stroke="#94a3b8" strokeDasharray="4 4"/>
      <polyline points={`${x(0)},${y(0)} ${journey.points.map((p,i)=>`${x(i+1)},${y(value(p))}`).join(' ')}`} fill="none" stroke="#8b9dff" strokeWidth="2.5"/>
      {journey.points.map((p,i)=><circle key={`${p.session_id}:${p.cycle_id}`} cx={x(i+1)} cy={y(value(p))} r="5" fill={p.delta>=0?'#4ade80':'#fb7185'} tabIndex={0} role="button" aria-label={`${p.grouped?`${p.members.length} trades`:`Trade ${tradeNumbers[i]}`}: ${format(value(p))}`} onMouseEnter={()=>inspect(p)} onFocus={()=>inspect(p)} onClick={()=>{inspect(p);if(!p.grouped)onSelect?.(p.members[0])}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(p);if(!p.grouped)onSelect?.(p.members[0])}}}>
        <title>{p.label} · {new Date(p.time*1000).toISOString().slice(11,19)} IST · trade {money(p.delta)} · cumulative {format(value(p))}</title>
      </circle>)}
      <text x="64" y="217" fill="#94a3b8" fontSize="12">Start: 0</text><text x="575" y="217" textAnchor="end" fill="#cbd5e1" fontSize="12">{journey.completed} completed trades · {format(value(journey.points[journey.points.length-1]))}</text>
    </svg>:<p className="day-journey-empty">No completed trades yet.</p>}
    <div className="day-journey-detail" aria-live="polite">{current?`${current.label} · ${new Date(current.time*1000).toISOString().slice(11,19)} IST · Trade ${money(current.delta)}${current.delta_pct!=null?` (${current.delta_pct.toFixed(2)}%)`:''} · Cumulative ${format(value(current))}`:'Hover or focus a point to inspect the completed trade.'}</div>
    {current?.grouped&&<div role="group" aria-label="Same-second trades">{current.members.map(member=>onSelect?<button key={`${member.session_id}:${member.cycle_id}`} onClick={()=>onSelect?.(member)}>{member.label} · {money(member.delta)} · Inspect trade {member.cycle_id.slice(0,8)}</button>:<span key={`${member.session_id}:${member.cycle_id}`}>{member.label} · {money(member.delta)} </span>)}</div>}
    {journey.points.some(p=>p.grouped)&&<p>Same-second trades with unknown order are grouped. Intrasecond peaks and drawdowns are unavailable.</p>}
    <small>Net of commission. Completed trades only; open positions and partial exits in unfinished cycles are excluded.{journey.open_cycles>0?' The summary can include realized amounts from unfinished cycles.':''}</small>
  </section>
}

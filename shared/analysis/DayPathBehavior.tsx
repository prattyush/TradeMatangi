import { useEffect, useState } from 'react'
import { useOptionalAnalysisEnvironment } from './environment'
import type { DayPath, JourneyMember } from './dayJourney'
import DayJourneyChart from './DayJourneyChart'
import { scoreKey } from './dayScore/model'
const money=(v:number)=>`₹${v.toLocaleString('en-IN',{maximumFractionDigits:2})}`
const pct=(v:number|null)=>v==null?'—':`${v.toFixed(2)}%`
const ratio=(v:number|null)=>v==null?'—':`${v.toFixed(2)}×`
const account=(p:DayPath)=>[p.mode==='sim'?'Replay':p.mode,p.execution_broker,p.broker_account_id].filter(Boolean).join(' · ')
const scope=(p:DayPath)=>[p.user_id,p.mode,p.execution_broker,p.broker_account_id].join(':')
type Trend='max_drawdown_pct'|'downward_pct'|'giveback_pct'|'allocation'|'risk'|'day_score'
const SCORE_ROUNDS=4 // each round scores up to 31 days that have no stored score yet
export default function DayPathBehavior({paths,onSelect}:{paths:DayPath[];onSelect:(cycle:JourneyMember)=>void}) {
  const [id,setId]=useState(''),[metric,setMetric]=useState<Trend>('max_drawdown_pct')
  const scoreSource=useOptionalAnalysisEnvironment()?.dayScore
  const [scores,setScores]=useState<Map<string,number>>(new Map()),[scoring,setScoring]=useState<{loading:boolean;left:number;error:string}>({loading:false,left:0,error:''})
  const firstDate=paths.length?paths.reduce((m,p)=>p.date<m?p.date:m,paths[0].date):'',lastDate=paths.length?paths.reduce((m,p)=>p.date>m?p.date:m,paths[0].date):''
  // The day score trend is read only when it is chosen: scoring a day reads cached candles, so it is bounded and done a few rounds at a time.
  useEffect(()=>{
    if(metric!=='day_score'||!scoreSource||!firstDate)return
    let live=true
    setScoring({loading:true,left:0,error:''})
    void(async()=>{
      try{
        let left=0
        for(let round=0;round<SCORE_ROUNDS&&live;round++){
          const result=await scoreSource.range(firstDate,lastDate,true)
          if(!live)return
          setScores(new Map(result.scores.map(row=>[scoreKey(row.date,row.mode),row.score])));left=result.pending
          if(!left)break
        }
        if(live)setScoring({loading:false,left,error:''})
      }catch(cause){if(live)setScoring({loading:false,left:0,error:cause instanceof Error?cause.message:String(cause)})}
    })()
    return()=>{live=false}
  },[metric,scoreSource,firstDate,lastDate])
  const selected=paths.find(p=>p.id===id)??paths[paths.length-1]
  if(!selected)return null
  const series=paths.filter(p=>scope(p)===scope(selected)).sort((a,b)=>a.date.localeCompare(b.date))
  const values=series.map(p=>metric==='day_score'?(scores.get(scoreKey(p.date,p.mode))??null):metric==='allocation'||metric==='risk'?p.sizing_ratio[metric]:p[metric])
  const high=metric==='day_score'?100:Math.max(1,...values.filter((v):v is number=>v!=null))
  const x=(i:number)=>50+i/Math.max(1,series.length-1)*520,y=(v:number)=>100-v/high*78
  const labels={max_drawdown_pct:'Maximum drawdown (%)',downward_pct:'Total downward movement (%)',giveback_pct:'Profit given back (%)',allocation:'Allocation ratio: down / up',risk:'Initial-risk ratio: down / up',day_score:'Day score (0 to 100)'}
  const metricOptions=Object.entries(labels).filter(([key])=>key!=='day_score'||scoreSource)
  return <section className="pa-card day-paths" aria-label="Day P&L path and sizing">
    <h3>Day P&amp;L path and sizing</h3>
    <p className="day-path-note">Completed-trade realized P&amp;L under the current filters. These observations describe the path, not trading maturity or live account equity.</p>
    <div className="day-path-table"><table><thead><tr><th>Date / mode / account</th><th>Net P&amp;L</th><th>Max drawdown</th><th>Downward movement</th><th>Profit given back</th><th>Allocation down / up</th><th>Risk down / up</th></tr></thead><tbody>
      {[...paths].reverse().map(p=><tr key={p.id} aria-selected={selected.id===p.id}><td><button aria-label={`Inspect day path ${p.date} ${account(p)}`} title={`User: ${p.user_id??'unknown'}`} onClick={()=>setId(p.id)}>{p.date} · {account(p)}</button></td><td>{money(p.net_pnl)} · {pct(p.net_pnl_pct)}</td><td>{money(p.max_drawdown)} · {pct(p.max_drawdown_pct)}</td><td>{money(p.downward)} · {pct(p.downward_pct)}</td><td>{money(p.giveback)} · {pct(p.giveback_pct)}</td><td>{ratio(p.sizing_ratio.allocation)}</td><td>{ratio(p.sizing_ratio.risk)}</td></tr>)}
    </tbody></table></div>
    <p className="day-path-note">Drawdown is peak-to-trough from an initial zero. Downward movement sums losing completed trades. Giveback is peak P&amp;L minus final P&amp;L. Percentages use average starting session capital.</p>
    <DayJourneyChart journey={selected} title={`${selected.date} P&L journey`} onSelect={onSelect}/>
    <h4>Entry sizing by realized day P&amp;L before entry</h4>
    <div className="day-sizing">{(['down','up','flat'] as const).map(state=>{const b=selected.sizing[state];return <div key={state}><strong>{state==='down'?'Below zero':state==='up'?'Above zero':'At zero'} · {b.entries} entries</strong><span>Median allocation {pct(b.median_allocation_pct)}</span><small>{b.allocation_count}/{b.entries} recorded</small><span>Median initial risk {pct(b.median_risk_pct)}</span><small>{b.risk_count}/{b.entries} recorded</small></div>})}</div>
    <p className="day-path-note">Includes filled entries and additions, normalized to their entry capital. Missing sizing remains unavailable. {selected.sizing.unknown.entries} entries have unknown sequencing (missing time or a close in the same second). Ratios require valid samples on both sides; compare sample counts before drawing conclusions. Open-position unrealized P&amp;L is excluded.</p>
    <h4>Across days · {account(selected)}</h4>
    <select aria-label="Day behavior trend metric" value={metric} onChange={e=>setMetric(e.target.value as Trend)}>{metricOptions.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
    {metric==='day_score'&&<p className="day-path-note" role="status" data-testid="score-trend-note">{scoring.error?`The scores could not be read: ${scoring.error}`:scoring.loading?'Scoring the days…':scoring.left?`${scoring.left} more days still to score: choose the metric again to continue.`:'A day has a score once every closed trade on it is labelled; the other days are gaps. Higher is better.'}</p>}
    <svg className="day-trend" viewBox="0 0 610 130" role="img" aria-label={labels[metric]}>
      <line x1="50" x2="570" y1="100" y2="100" stroke="#64748b"/>
      <text x="4" y="26" fill="#94a3b8" fontSize="11">{high.toFixed(2)}</text><text x="22" y="104" fill="#94a3b8" fontSize="11">0</text>
      {values.map((v,i)=>v==null?null:<g key={series[i].id}>{i>0&&values[i-1]!=null&&<line x1={x(i-1)} x2={x(i)} y1={y(values[i-1]!)} y2={y(v)} stroke="#8b9dff" strokeWidth="2"/>}<circle cx={x(i)} cy={y(v)} r="4" fill="#a5b4fc"><title>{series[i].date}: {v.toFixed(2)}</title></circle></g>)}
      <text x="50" y="122" fill="#94a3b8" fontSize="11">{series[0]?.date}</text><text x="570" y="122" textAnchor="end" fill="#94a3b8" fontSize="11">{series[series.length-1]?.date}</text>
    </svg>
    <small className="day-path-note">One observation per date for this user/mode/account; missing measurements leave gaps.{metric==='day_score'?' The day score is for the whole date, across its sessions.':' No maturity score is assigned.'}</small>
  </section>
}

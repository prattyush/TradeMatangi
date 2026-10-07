import { useEffect, useMemo, useRef, useState } from 'react'
import { GroupCard, groupSessions } from '../../shared/analysis/TradeAnalysis'
import type { SessionSummary } from '../../shared/analysis/api'
import { useAnalysisEnvironment } from '../../shared/analysis/environment'

const money=(n:number)=>`₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`
export default function DesktopAnalysisSessions() {
  const environment=useAnalysisEnvironment(); const api=environment.api
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date())
  const [filters,setFilters]=useState({symbol:'',instrumentType:'',sessionType:'',startDate:new Date(Date.parse(today+'T00:00:00Z')-29*86400000).toISOString().slice(0,10),endDate:today})
  const [sessions,setSessions]=useState<SessionSummary[]>([])
  const [selected,setSelected]=useState('')
  const [error,setError]=useState('');const [loading,setLoading]=useState(false)
  const [refresh,setRefresh]=useState(0);const [width,setWidth]=useState(300);const [collapsed,setCollapsed]=useState(window.innerWidth<1100)
  const request=useRef(0);const root=useRef<HTMLDivElement>(null)
  const groups=useMemo(()=>groupSessions(sessions),[sessions])
  const current=groups.find(g=>g.key===selected) ?? groups[0]
  useEffect(()=>{
    let cancelled=false;const revision=++request.current
    setLoading(true);setError('')
    void api.getAnalysisSessions(filters).then(rows=>{if(!cancelled&&revision===request.current){setSessions(rows);environment.onSelectionContextChange?.()}}).catch(reason=>{if(!cancelled&&revision===request.current&&reason?.name!=='AbortError')setError(String(reason))}).finally(()=>{if(!cancelled&&revision===request.current)setLoading(false)})
    return()=>{cancelled=true}
  },[api,filters,refresh])
  const navigate=(action:()=>void)=>{if(environment.confirmDiscard?.()===false)return;environment.onSelectionContextChange?.();action()}
  const field=(key:keyof typeof filters,value:string)=>navigate(()=>setFilters(old=>({...old,[key]:value})))
  return <div className={`analysis-session-workspace ${collapsed?'navigator-collapsed':''}`} ref={root} style={{'--analysis-navigator-width':`${width}px`} as React.CSSProperties}>
    <header className="analysis-session-filters"><button aria-expanded={!collapsed} onClick={()=>setCollapsed(v=>!v)}>Sessions</button>
      <label>Symbol<select aria-label="Analysis symbol" value={filters.symbol} onChange={e=>field('symbol',e.target.value)}><option value="">All symbols</option>{['NIFTY','BSESEN','TATPOW','TATMOT','RELIND'].map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Instrument<select aria-label="Analysis instrument" value={filters.instrumentType} onChange={e=>field('instrumentType',e.target.value)}><option value="">All instruments</option><option value="equity">Equity</option><option value="options">Options</option></select></label>
      <label>Mode<select aria-label="Analysis mode" value={filters.sessionType} onChange={e=>field('sessionType',e.target.value)}><option value="">All modes</option><option value="paper">Paper</option><option value="real">Real</option><option value="sim">Replay</option><option value="stepwise">Stepwise</option></select></label>
      <label>From<input aria-label="Analysis from date" type="date" value={filters.startDate} onChange={e=>field('startDate',e.target.value)}/></label><label>Through<input aria-label="Analysis through date" type="date" value={filters.endDate} onChange={e=>field('endDate',e.target.value)}/></label>
      <button disabled={loading} onClick={()=>navigate(()=>setRefresh(n=>n+1))}>Refresh</button>
    </header>
    <aside className="analysis-session-navigator" aria-label="Session navigator"><p>{groups.length} groups · {money(groups.reduce((sum,g)=>sum+g.totalPnl,0))}</p>{groups.map(group=><button key={group.key} aria-pressed={current?.key===group.key} onClick={()=>navigate(()=>{setSelected(group.key);if(window.innerWidth<1100)setCollapsed(true)})}><strong>{group.date} · {group.symbol}</strong><span>{group.sessions[0]?.shared ? `Shared by ${group.sessions[0].owner_email ?? group.sessions[0].user_id} · ` : ''}{group.instrument_type} · {group.session_type==='sim'?'Replay':group.session_type} · {group.sessions.length} session(s)</span><span>{money(group.totalPnl)} · {group.totalTrades} closed trades</span></button>)}</aside>
    <div className="analysis-navigator-separator" role="separator" aria-label="Resize session navigator" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={480} aria-valuenow={width} tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(n=>Math.max(240,Math.min(480,n+(e.key==='ArrowLeft'?-20:20))))}}} onPointerDown={e=>e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId)){const box=root.current?.getBoundingClientRect();if(box)setWidth(Math.max(240,Math.min(480,e.clientX-box.left)))}}}/>
    <div className="analysis-selected-session" aria-label="Selected session">
      {loading&&<p role="status">Reading sessions…</p>}{error&&<p role="alert">{error}<button onClick={()=>setRefresh(n=>n+1)}>Retry</button></p>}
      {!loading&&!error&&!current&&<p>No executions for these filters.</p>}
      {current&&!error&&<GroupCard key={`${current.key}:${refresh}`} group={current} historicalDays={environment.historicalDays} initiallyExpanded />}
    </div>
  </div>
}

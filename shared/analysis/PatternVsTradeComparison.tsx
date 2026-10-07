import type { TradesChartProps, PatternChartProps } from './chartProps'
import { useAnalysisApi, useAnalysisEnvironment } from './environment'
/**
 * PatternVsTradeComparison — 2×1 side-by-side view comparing trades vs patterns.
 * CE/PE strike buttons swap the chart OHLC. Tab-style, one active at a time.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'

import { AnalysisTrade, TradeLabel, PatternAnnotation, TopPatterns } from './api'


type InstFilter = 'underlying' | 'CE' | 'PE'
interface StrikeTab { key: string; label: string; right: string; strike: number; expiry: string; trades: AnalysisTrade[] }
interface Props { symbol: string; date: string; instrumentType: string; sessionIds: string[]; allTrades: AnalysisTrade[]; historicalDays: number; onClose: () => void }





function useStrikeTabs(allTrades: AnalysisTrade[], isOpt: boolean): StrikeTab[] {
  return useMemo(() => {
    if (!isOpt) return []
    const m = new Map<string, StrikeTab>()
    for (const t of allTrades) { if (!t.right||t.strike==null||!t.expiry) continue; const k=`${t.right}-${t.strike}-${t.expiry}`; if(!m.has(k)) m.set(k,{key:k,label:`${t.right} ${t.strike}`,right:t.right,strike:t.strike,expiry:t.expiry,trades:[]}); m.get(k)!.trades.push(t) }
    return [...m.values()].sort((a,b)=>a.right!==b.right?(a.right==='CE'?-1:1):a.strike-b.strike)
  }, [allTrades, isOpt])
}

function Btn({s,onClick,active,children,title}:{s?:boolean;onClick?:()=>void;active?:boolean;children:React.ReactNode;title?:string}) {
  return <button onClick={onClick} title={title} style={{padding:s?'3px 10px':'4px 12px',fontSize:11,fontWeight:600,borderRadius:4,border:`1px solid ${active?'#58a6ff':'#30363d'}`,background:active?'#1f3a5f':'#161b22',color:active?'#58a6ff':'#8b949e',cursor:'pointer'}}>{children}</button>
}

export default function PatternVsTradeComparison({symbol,date,instrumentType,sessionIds,allTrades,historicalDays: _hd,onClose}:Props) {
  const api = useAnalysisApi()

  const [labelMap,slm]=useState<Map<string,TradeLabel[]>>(new Map())
  const [pAnn,spa]=useState<PatternAnnotation[]>([]); const [tp,stp]=useState<TopPatterns>({})
  const [strategies,ss]=useState<string[]>([]); const [categories,scat]=useState<string[]>([])
  const [acat,sac]=useState(''); const [astr,sas]=useState('')
  const [instFilter,sif]=useState<InstFilter>('underlying'); const [max,smax]=useState<string|null>(null)
  const isOpt=instrumentType==='options'; const strikeTabs=useStrikeTabs(allTrades,isOpt)
  const [pStrike,spStrike]=useState<{ce:number|null;pe:number|null;exp:string|null}>({ce:null,pe:null,exp:null})
  const environment = useAnalysisEnvironment()
  const [error,setError] = useState(''); const [loading,setLoading] = useState(true); const [retry,setRetry] = useState(0)
  const sessionKey = sessionIds.join('|')
  useEffect(()=>{
    let cancelled=false; setLoading(true); setError('')
    void (async()=>{
      const [rtRes,lblRes,pChart,cats,strats] = await Promise.all([
        Promise.all(sessionIds.map(id=>api.getRoundTrips(id))),Promise.all(sessionIds.map(id=>api.getLabels(id))),
        api.patternGetChartByDate(symbol,date,isOpt?'options':'equity'),api.patternListCategories(),api.patternListStrategies(),
      ])
      const expiry = isOpt && pChart?.strike ? await api.getExpiry(symbol,date) : null
      if(cancelled)return
      const map=new Map<string,TradeLabel[]>()
      sessionIds.forEach((id,i)=>{ const trips=new Map(rtRes[i].map(trip=>[trip.index,trip])); lblRes[i].forEach(label=>{const trip=trips.get(label.round_trip_index);if(trip)[...trip.entry_trades,...trip.exit_trades].forEach(trade=>[trade.trade_id,trade.execution_id].filter(Boolean).forEach(identity=>{const key=`${id}:${identity}`;const existing=map.get(key)??[];if(!existing.some(item=>item.round_trip_index===label.round_trip_index))map.set(key,[...existing,label])}))}) })
      slm(map);spa(pChart?.annotations??[]);stp(pChart?.top_patterns??{});ss(strats.strategies);scat(cats.categories)
      spStrike({ce:pChart?.strike??null,pe:pChart?.strike??null,exp:expiry?.expiry??null})
    })().catch(reason=>{if(!cancelled)setError(String(reason))}).finally(()=>{if(!cancelled)setLoading(false)})
    return()=>{cancelled=true}
  },[api,symbol,date,isOpt,sessionKey,retry])
  useEffect(()=>{if(!max)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')smax(null)};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape)},[max])
  const gmt=useCallback((trade:AnalysisTrade):string=>{
    const found=[...new Map([trade.trade_id,trade.execution_id,trade.stored_trade_id].filter(Boolean).flatMap(identity=>labelMap.get(`${trade.session_id}:${identity}`)??[]).map(label=>[label.round_trip_index,label])).values()]
    const names=found.map(label=>{const strategy=label.expected_strategy||label.actual_strategy;return strategy?`${label.expected_category?label.expected_category.slice(0,5)+'/':''}${strategy.slice(0,10)}`:''}).filter(Boolean)
    return names.length?[...new Set(names)].join(' / '):trade.side==='BUY'?'B':'S'
  },[labelMap])

  if(max && !environment.desktop) return <div style={{position:'fixed',inset:0,zIndex:200,background:'#0d1117',display:'flex',flexDirection:'column'}}><div style={{display:'flex',alignItems:'center',padding:'8px 16px',background:'#161b22',borderBottom:'1px solid #30363d'}}><span style={{fontSize:14,fontWeight:700,color:'#e6edf3'}}>{symbol} · {date}</span><div style={{flex:1}}/><Btn onClick={()=>smax(null)}>⤡ Restore</Btn></div><div style={{flex:1,padding:8,overflow:'auto'}}>{max==='trades-underlying'&&<TradesChart symbol={symbol} date={date} trades={allTrades} getMarkerText={gmt} strikeTabs={strikeTabs} isOpt={isOpt}/>}{max==='patterns-underlying'&&<PatternChart symbol={symbol} date={date} annotations={pAnn} topPatterns={tp} activeStrategy={astr||null} activeCategory={acat||null} instFilter={instFilter} setInstFilter={sif} isOpt={isOpt} patternStrike={pStrike}/>}</div></div>

  return <div className={`analysis-comparison-view ${max?'comparison-maximized':''}`} data-max={max??''} role="dialog" aria-label="Pattern comparison" style={{position:'fixed',inset:0,zIndex:99,background:'#0d1117',display:'flex',flexDirection:'column'}}>
    <div style={{display:'flex',alignItems:'center',gap:12,padding:'12px 20px',borderBottom:'1px solid #21262d',flexShrink:0}}>
      <div><div style={{fontSize:18,color:'#e6edf3',fontWeight:600}}>📊 Pattern vs Trade: {symbol} · {date}</div><div style={{fontSize:12,color:'#484f58',marginTop:4}}>Compare actual trades against saved pattern annotations</div></div>
      <div style={{width:1,height:24,background:'#30363d',margin:'0 8px'}}/><span style={{fontSize:11,color:'#8b949e'}}>Filter:</span>
      <select value={acat} onChange={e=>sac(e.target.value)} style={sel}><option value="">All categories</option>{categories.map(c=><option key={c} value={c}>{c}</option>)}</select>
      <select value={astr} onChange={e=>sas(e.target.value)} style={sel}><option value="">All strategies</option>{strategies.map(s=><option key={s} value={s}>{s}</option>)}</select>
      <div style={{flex:1}}/><span style={{fontSize:11,color:'#484f58'}}>{pAnn.length} annotations · {labelMap.size} labeled trades</span>
      <button onClick={onClose} style={{background:'none',border:'1px solid #30363d',borderRadius:6,color:'#8b949e',fontSize:13,cursor:'pointer',padding:'6px 16px'}}>✕ Close</button>
    </div>
    {error&&<p role="alert">{error}<button onClick={()=>setRetry(n=>n+1)}>Retry comparison</button></p>}
    {loading&&<p role="status">Loading comparison…</p>}
    {max&&environment.desktop&&<button onClick={()=>smax(null)}>Restore comparison</button>}
    <div style={{flex:1,display:'flex',overflow:'hidden'}}>
      <div className="comparison-trades-pane" style={{flex:1,display:'flex',padding:'8px 4px',borderRight:'1px solid #21262d'}}>
        <TradesChart symbol={symbol} date={date} trades={allTrades} getMarkerText={gmt} strikeTabs={strikeTabs} isOpt={isOpt} onMax={()=>smax('trades-underlying')}/>
      </div>
      <div className="comparison-pattern-pane" style={{flex:1,display:'flex',padding:'8px 4px'}}>
        <PatternChart symbol={symbol} date={date} annotations={pAnn} topPatterns={tp} activeStrategy={astr||null} activeCategory={acat||null} instFilter={instFilter} setInstFilter={sif} isOpt={isOpt} patternStrike={pStrike} onMax={()=>smax('patterns-underlying')}/>
      </div>
    </div>
  </div>
}

const sel: React.CSSProperties = {background:'#161b22',border:'1px solid #30363d',color:'#e6edf3',borderRadius:4,padding:'4px 8px',fontSize:11,minWidth:140}

export function TradesChart(props: TradesChartProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.TradesChart
  if (environment.desktop && environment.active === false) return null
  if (!Override) throw new Error('Analysis chart renderer TradesChart is not configured')
  return <Override {...props} />
}

export function PatternChart(props: PatternChartProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.PatternChart
  if (environment.desktop && environment.active === false) return null
  if (!Override) throw new Error('Analysis chart renderer PatternChart is not configured')
  return <Override {...props} />
}

import { useState, useEffect, useRef, useMemo } from 'react'
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts'
import { useAnalysisApi } from '../../../../shared/analysis/environment'
import type { AnalysisTrade, OHLCCandle, PatternAnnotation, TopPatterns } from '../../../../shared/analysis/api'
import type { StrikeTab, InstFilter } from '../../../../shared/analysis/chartProps'
import { buildMarkers } from '../../services/patternMarkers'
function nextEMA(p: number, c: number, k: number) { return c * k + p * (1 - k) }
function computeEMA(cl: number[], n: number): (number | null)[] {
  const r: (number | null)[] = []; const k = 2 / (n + 1); let e: number | null = null; let w = 0, s = 0
  for (let i = 0; i < cl.length; i++) { s += cl[i]; w++; if (w < n) r.push(null); else if (w === n) { e = s / n; r.push(e) } else { e = nextEMA(e!, cl[i], k); r.push(e) } }
  return r
}
function effSide(t: AnalysisTrade): 'BUY' | 'SELL' { return t.right === 'PE' ? (t.side === 'BUY' ? 'SELL' : 'BUY') : t.side }
function Btn({s,onClick,active,children,title}:{s?:boolean;onClick?:()=>void;active?:boolean;children:React.ReactNode;title?:string}) {
  return <button onClick={onClick} title={title} style={{padding:s?'3px 10px':'4px 12px',fontSize:11,fontWeight:600,borderRadius:4,border:`1px solid ${active?'#58a6ff':'#30363d'}`,background:active?'#1f3a5f':'#161b22',color:active?'#58a6ff':'#8b949e',cursor:'pointer'}}>{children}</button>
}
function StrikeBtn({active, children, onClick, right}: {active:boolean;children:React.ReactNode;onClick:()=>void;right?: string}) {
  const c = right === 'CE' ? '#22c55e' : right === 'PE' ? '#7c3aed' : '#8b949e'
  return <button onClick={onClick} style={{padding:'3px 10px',fontSize:11,fontWeight:600,borderRadius:4,border:`1px solid ${active?c:'#30363d'}`,background:active?'#161b22':'#161b22',color:active?c:'#484f58',cursor:'pointer'}}>{children}</button>
}
// ── Trades Chart (left) ─────────────────────────────────────────────────

export function WebsiteTradesChart({symbol,date,trades,getMarkerText,strikeTabs,isOpt,onMax}:{symbol:string;date:string;trades:AnalysisTrade[];getMarkerText:(t:AnalysisTrade)=>string;strikeTabs:StrikeTab[];isOpt:boolean;onMax?:()=>void}) {
  const api = useAnalysisApi()

  const cr = useRef<HTMLDivElement>(null); const ch = useRef<IChartApi|null>(null); const sr = useRef<ISeriesApi<'Candlestick'>|null>(null); const pool = useRef<ISeriesApi<'Line'>[]>([]); const e9r = useRef<ISeriesApi<'Line'>|null>(null); const e21r = useRef<ISeriesApi<'Line'>|null>(null)
  const [cc,sc] = useState<CandlestickData[]>([]); const [mf,smf] = useState<'all'|'CE'|'PE'>('all'); const [activeStrike, setActiveStrike] = useState<string>('')

  const activeTab = !activeStrike ? null : strikeTabs.find(s => s.key === activeStrike) ?? null

  useEffect(()=>{const el=cr.current;if(!el)return;const c=createChart(el,{width:el.clientWidth||500,height:(el.parentElement?.clientHeight||400)-50,layout:{background:{color:'#0d1117'},textColor:'#e6edf3'},grid:{vertLines:{color:'#1e2732'},horzLines:{color:'#1e2732'}},timeScale:{timeVisible:true,secondsVisible:false,borderColor:'#30363d'},crosshair:{mode:0}});ch.current=c;sr.current=c.addCandlestickSeries({upColor:'#26a641',downColor:'#f85149',borderVisible:false,wickUpColor:'#26a641',wickDownColor:'#f85149'});e9r.current=c.addLineSeries({color:'#f0883e',lineWidth:1,lastValueVisible:false,priceLineVisible:false});e21r.current=c.addLineSeries({color:'#79c0ff',lineWidth:1,lastValueVisible:false,priceLineVisible:false});const ro=new ResizeObserver(e=>{c.applyOptions({width:e[0].contentRect.width})});ro.observe(el);return()=>{ro.disconnect();c.remove()}},[])

  // Load OHLC: underlying vs option
  useEffect(()=>{const s=sr.current;if(!s||!symbol||!date)return;let canc=false;(async()=>{try{const tc=(c:OHLCCandle):CandlestickData=>({time:c.time as Time,open:c.open,high:c.high,low:c.low,close:c.close});let sd:CandlestickData[]
    if(activeTab){const r=await api.patternOhlcOptions(symbol,date,activeTab.strike,activeTab.expiry,activeTab.right,3,2);if(canc||!sr.current)return;sd=r.candles.map(tc)}else{const[h,td]=await Promise.all([api.getHistorical(symbol,date,3,2),api.getPreSession(symbol,date,'15:30:00',3)]);if(canc||!sr.current)return;const a=[...h.candles.map(tc),...td.map(tc)];const bt=new Map<number,CandlestickData>();a.forEach(c=>bt.set(c.time as number,c));sd=[...bt.values()].sort((a,b)=>(a.time as number)-(b.time as number))}
    s.setData(sd);sc(sd);const cl=sd.map(c=>c.close);const e9=computeEMA(cl,9);const e21=computeEMA(cl,21);e9r.current?.setData(sd.map((c,i)=>({time:c.time,value:e9[i]!})).filter(d=>d.value!==null));e21r.current?.setData(sd.map((c,i)=>({time:c.time,value:e21[i]!})).filter(d=>d.value!==null));ch.current?.timeScale().fitContent()}catch{}})();return()=>{canc=true}},[symbol,date,activeStrike])
  useEffect(()=>{e9r.current?.applyOptions({visible:true});e21r.current?.applyOptions({visible:true})},[])

  const displayTrades = activeTab ? activeTab.trades : (mf==='all'?trades:trades.filter(t=>!t.right||t.right===mf))
  const iv=3*60
  useEffect(()=>{const c=ch.current;if(!c)return;for(const s of pool.current){try{c.removeSeries(s)}catch{}}pool.current=[];if(displayTrades.length===0)return;for(const t of displayTrades){const slot=Math.floor(t.timestamp/iv)*iv;const mp=activeTab?t.price:(t.right?(t.underlying_price??cc.find(c=>(c.time as number)===slot)?.close):t.price);if(mp===undefined)continue;try{const s=c.addLineSeries({lineVisible:false,crosshairMarkerVisible:false,lastValueVisible:false,priceLineVisible:false});s.setData([{time:slot as Time,value:mp}]);s.setMarkers([{time:slot as Time,position:'inBar',color:effSide(t)==='BUY'?'#FFFFFF':'#00AAFF',shape:'circle',text:getMarkerText(t),size:0.6}]);pool.current.push(s)}catch{}}},[displayTrades,cc,getMarkerText,activeTab])

  return <div style={{display:'flex',flexDirection:'column',flex:1,minHeight:0}}>
    <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:4,flexWrap:'wrap'}}>
      <StrikeBtn active={!activeStrike} onClick={()=>setActiveStrike('')}>Underlying</StrikeBtn>
      {strikeTabs.map(s=><StrikeBtn key={s.key} active={activeStrike===s.key} onClick={()=>setActiveStrike(s.key)} right={s.right}>{s.label}</StrikeBtn>)}
    </div>
    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>{isOpt&&!activeTab&&['all','CE','PE'].map(f=><Btn key={f} s onClick={()=>smf(f as any)} active={mf===f}>{f==='all'?'All':f}</Btn>)}<div style={{flex:1}}/>{onMax&&<Btn s onClick={onMax} title="Maximize">⤢</Btn>}</div>
    <div ref={cr} style={{flex:1}}/>
  </div>
}

// ── Pattern Chart (right) ──────────────────────────────────────────────

export function WebsitePatternChart({symbol,date,annotations,topPatterns,activeStrategy,activeCategory,instFilter,setInstFilter,isOpt,patternStrike,onMax}:{symbol:string;date:string;annotations:PatternAnnotation[];topPatterns:TopPatterns;activeStrategy:string|null;activeCategory:string|null;instFilter:InstFilter;setInstFilter:(f:InstFilter)=>void;isOpt:boolean;patternStrike:{ce:number|null;pe:number|null;exp:string|null};onMax?:()=>void}) {
  const api = useAnalysisApi()

  const cr=useRef<HTMLDivElement>(null);const ch=useRef<IChartApi|null>(null);const sr=useRef<ISeriesApi<'Candlestick'>|null>(null);const e9r=useRef<ISeriesApi<'Line'>|null>(null);const e21r=useRef<ISeriesApi<'Line'>|null>(null);const [cc,sc]=useState<CandlestickData[]>([])
  const [activeStrike, setActiveStrike] = useState<string>('')

  const patternTabs: StrikeTab[] = useMemo(()=>{
    const tabs: StrikeTab[] = []
    if(patternStrike.exp&&patternStrike.ce&&annotations.some(a=>a.instrument==='CE')) tabs.push({key:'CE',label:'CE '+patternStrike.ce,right:'CE',strike:patternStrike.ce,expiry:patternStrike.exp,trades:[]})
    if(patternStrike.exp&&patternStrike.pe&&annotations.some(a=>a.instrument==='PE')) tabs.push({key:'PE',label:'PE '+patternStrike.pe,right:'PE',strike:patternStrike.pe,expiry:patternStrike.exp,trades:[]})
    return tabs
  },[patternStrike,annotations])

  const activeTab = activeStrike === 'CE' || activeStrike === 'PE' ? patternTabs.find(t=>t.right===activeStrike)??null : null

  const ftr=useMemo(()=>{
    if(activeTab) return annotations.filter(a=>a.instrument===activeTab.right)
    if(!isOpt) return annotations.filter(a=>a.instrument==='underlying')
    return annotations.filter(a=>a.instrument===instFilter)
  },[annotations,instFilter,activeTab,isOpt])

  useEffect(()=>{const el=cr.current;if(!el)return;const c=createChart(el,{width:el.clientWidth||500,height:(el.parentElement?.clientHeight||400)-50,layout:{background:{color:'#0d1117'},textColor:'#8b949e'},grid:{vertLines:{color:'#21262d'},horzLines:{color:'#21262d'}},timeScale:{timeVisible:true,secondsVisible:false},crosshair:{mode:0},handleScroll:{vertTouchDrag:false}});ch.current=c;sr.current=c.addCandlestickSeries({upColor:'#22c55e',downColor:'#ef4444',borderUpColor:'#22c55e',borderDownColor:'#ef4444',wickUpColor:'#22c55e',wickDownColor:'#ef4444'});e9r.current=c.addLineSeries({color:'#f0883e',lineWidth:1,priceLineVisible:false,lastValueVisible:false});e21r.current=c.addLineSeries({color:'#79c0ff',lineWidth:1,priceLineVisible:false,lastValueVisible:false});const ro=new ResizeObserver(e=>{c.applyOptions({width:e[0].contentRect.width})});ro.observe(el);return()=>{ro.disconnect();c.remove()}},[])

  useEffect(()=>{const s=sr.current;if(!s)return;let canc=false;(async()=>{try{let d:CandlestickData[]
    if(activeTab){const r=await api.patternOhlcOptions(symbol,date,activeTab.strike,activeTab.expiry,activeTab.right,3,2);if(canc||!sr.current)return;d=r.candles.map(c=>({time:c.time as Time,open:c.open,high:c.high,low:c.low,close:c.close}))}else{const r=await api.patternOhlcEquity(symbol,date,3,2);if(canc||!sr.current)return;d=r.candles.map(c=>({time:c.time as Time,open:c.open,high:c.high,low:c.low,close:c.close}))}
    s.setData(d);sc(d);const cl=d.map(c=>c.close);const e9=computeEMA(cl,9);const e21=computeEMA(cl,21);e9r.current?.setData(d.map((c,i)=>({time:c.time,value:e9[i]!})).filter(dd=>dd.value!==null));e21r.current?.setData(d.map((c,i)=>({time:c.time,value:e21[i]!})).filter(dd=>dd.value!==null));ch.current?.timeScale().fitContent()}catch{}})();return()=>{canc=true}},[symbol,date,activeStrike])
  useEffect(()=>{e9r.current?.applyOptions({visible:true});e21r.current?.applyOptions({visible:true})},[])
  useEffect(()=>{const s=sr.current;if(!s||cc.length===0)return;s.setMarkers(buildMarkers(ftr,activeStrategy,activeCategory,topPatterns))},[cc,ftr,activeStrategy,activeCategory,topPatterns])

  return <div style={{display:'flex',flexDirection:'column',flex:1,minHeight:0}}>
    <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:4,flexWrap:'wrap'}}>
      {!activeTab&&isOpt&&(['underlying','CE','PE']as const).map(f=><Btn key={f} s onClick={()=>setInstFilter(f)} active={instFilter===f}>{f==='underlying'?'UL':f}</Btn>)}
      {!activeTab&&<div style={{width:1,height:16,background:'#30363d',margin:'0 4px'}}/>}
      <StrikeBtn active={!activeStrike} onClick={()=>setActiveStrike('')}>Underlying</StrikeBtn>
      {patternTabs.map(s=><StrikeBtn key={s.key} active={activeStrike===s.right} onClick={()=>setActiveStrike(s.right)} right={s.right}>{s.label}</StrikeBtn>)}
    </div>
    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><div style={{flex:1}}/>{onMax&&<Btn s onClick={onMax} title="Maximize">⤢</Btn>}</div>
    <div ref={cr} style={{flex:1}}/>
  </div>
}


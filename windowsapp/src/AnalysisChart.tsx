import { contractTabs } from './analysisContracts'
import { snapshotCandles, resolveSnapshotExecutions } from './analysisSnapshot'
import { useEffect, useMemo, useRef, useState } from 'react'
import { init, dispose, registerOverlay, type Chart, type KLineData } from 'klinecharts'
import type { AnalysisTrade, OHLCCandle, PatternAnnotation, TopPatterns } from '../../shared/analysis/api'
import { useAnalysisApi, useAnalysisEnvironment } from '../../shared/analysis/environment'
import { buildMarkers } from '../../frontend/src/services/patternMarkers'
import { analysisMarkers, type ExecutionMarker } from './analysisMarkers'

interface Props {
  symbol: string; date: string; trades?: AnalysisTrade[]; historicalDays?: number
  exchange?: string; product?: string;
  strike?: number; expiry?: string; right?: string; title?: string; isMaximized?: boolean
  onMaximize?: () => void; onMax?: () => void; getMarkerText?: (trade: AnalysisTrade) => string
  observationResolution?: number;
  sessionId?: string; filledTrades?: Array<Partial<AnalysisTrade>>; barTime?: number
  barOhlc?: Omit<OHLCCandle, 'time'> | null; currentPrice?: number
  openOrders?: Array<{side:string;order_type:string;trigger_price:number;limit_price:number;quantity:number}>
  position?: {side:string;quantity:number;avg_entry_price:number} | null
  annotations?: PatternAnnotation[]; activeStrategy?: string | null; activeCategory?: string | null; topPatterns?: TopPatterns
}
let registered = false
function registerAnalysisOverlays() {
  if (registered) return
  registerOverlay({ name: 'analysisExecution', totalStep: 1, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    createPointFigures: ({coordinates,overlay}) => { const point=coordinates[0]; if(!point) return []; const marker=overlay.extendData as ExecutionMarker; return [
      {type:'circle',attrs:{x:point.x,y:point.y,r:6},styles:{color:marker.color,borderColor:marker.color,style:'fill'},ignoreEvent:false},
      {type:'text',attrs:{x:point.x,y:point.y-9,text:marker.text,align:'center',baseline:'bottom'},styles:{color:marker.color,size:11,weight:'bold'},ignoreEvent:false},
    ] },
  })
  registerOverlay({ name:'analysisAnnotation', totalStep:1, needDefaultPointFigure:false, needDefaultXAxisFigure:false, needDefaultYAxisFigure:false,
    createPointFigures:({coordinates,overlay})=>{ const p=coordinates[0]; if(!p) return []; const data=overlay.extendData as {color:string;text:string}; return [{type:'text',attrs:{x:p.x,y:p.y,text:data.text,align:'center',baseline:'bottom'},styles:{color:data.color,size:11},ignoreEvent:true}] },
  })
  registerOverlay({name:'analysisLevel',totalStep:1,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
    createPointFigures:({coordinates,bounding,overlay})=>{const point=coordinates[0];if(!point)return [];const level=overlay.extendData as {text:string};return [
      {type:'line',attrs:{coordinates:[{x:0,y:point.y},{x:bounding.width,y:point.y}]},styles:{color:'#a6b5cc',size:1,style:'dashed'},ignoreEvent:true},
      {type:'text',attrs:{x:8,y:point.y-4,text:level.text},styles:{color:'#cbd5e1',size:11},ignoreEvent:true},
    ]},
  })
  registered=true
}
const viewports = new Map<string,{barSpace:number; anchor:number}>()
export function clearAnalysisViewports() { viewports.clear() }
export default function DesktopAnalysisChart(props: Props) {
  const api=useAnalysisApi(); const environment=useAnalysisEnvironment()
  const historicalDays=props.historicalDays??environment.historicalDays??2
  const container=useRef<HTMLDivElement>(null); const chartRef=useRef<Chart|null>(null)
  const candlesRef=useRef<OHLCCandle[]>([]); const overlays=useRef<string[]>([])
  const [candles,setCandles]=useState<OHLCCandle[]>([]); const [error,setError]=useState(''); const [loading,setLoading]=useState(true); const [refresh,setRefresh]=useState(0)
  const [filter,setFilter]=useState('all'); const [chooser,setChooser]=useState<ExecutionMarker|null>(null)
  const [unavailableSnapshot,setUnavailableSnapshot]=useState<AnalysisTrade|null>(null)
  const key=`${props.sessionId??props.trades?.[0]?.session_id??'chart'}:${props.exchange??''}:${props.product??''}:${props.symbol}:${props.date}:${props.right??'underlying'}:${props.strike??''}:${props.expiry??''}:${props.barTime??''}`
  const keyRef=useRef(key); keyRef.current=key
  const loadedKey=useRef<string|null>(null)
  const selectRef=useRef(environment.onSelectExecution); selectRef.current=environment.onSelectExecution
  const generation=useRef(0)
  const restoring=useRef(false)
  const restoreAnchor=(chart:Chart, timestamp:number)=>{
    const point=chart.convertToPixel({timestamp},{paneId:'candle_pane'})
    const width=chart.getSize('candle_pane','main')?.width??container.current?.clientWidth??0
    if(!Array.isArray(point)&&typeof point.x==='number')chart.scrollByDistance(width/2-point.x,0)
  }
  const capturedTrades=useMemo(()=>props.trades ?? (props.filledTrades ?? []).map(t=>({ ...t, session_id:props.sessionId??'', user_id:'', symbol:props.symbol, instrument_type:t.right?'options':'equity', right:t.right??null, strike:t.strike??null, expiry:t.expiry??null, commission:t.commission??0 }) as AnalysisTrade),[props.trades,props.filledTrades,props.sessionId,props.symbol,props.expiry])
  const [resolvedTrades,setResolvedTrades]=useState<AnalysisTrade[]|null>(null)
  useEffect(()=>{
    let cancelled=false;setResolvedTrades(null)
    if(!props.filledTrades||!props.sessionId)return
    void api.getSessionDetail(props.sessionId).then(detail=>{if(!cancelled)setResolvedTrades(resolveSnapshotExecutions(capturedTrades,detail.trades))}).catch(()=>{if(!cancelled)setResolvedTrades(capturedTrades.map(t=>({...t,captured_only:true})))})
    return()=>{cancelled=true}
  },[api,capturedTrades,props.sessionId,props.filledTrades])
  const trades=resolvedTrades??capturedTrades
  const contract=props.right && props.strike && props.expiry ? {right:props.right,strike:props.strike,expiry:props.expiry,exchange:props.exchange,product:props.product}:undefined
  const markers=analysisMarkers(trades,candles,contract,filter,props.getMarkerText)
  const markersRef=useRef(markers); markersRef.current=markers
  const saveViewport=()=>{ const chart=chartRef.current; if(!chart||!candlesRef.current.length||restoring.current)return; const range=chart.getVisibleRange(); const index=Math.max(0,Math.min(candlesRef.current.length-1,Math.floor((range.from+range.to)/2))); viewports.set(loadedKey.current??keyRef.current,{barSpace:chart.getBarSpace().bar,anchor:candlesRef.current[index].time*1000}); while(viewports.size>32)viewports.delete(viewports.keys().next().value!) }
  useEffect(()=>{
    if(!container.current)return
    registerAnalysisOverlays(); const chart=init(container.current); if(!chart)return
    chartRef.current=chart; chart.setTimezone('Etc/UTC'); chart.setStyles('dark'); chart.setSymbol({ticker:props.symbol,pricePrecision:2,volumePrecision:0}); chart.setPeriod({span:3,type:'minute'})
    chart.createIndicator({name:'EMA',calcParams:[9,21],paneId:'candle_pane'},true)
    let lastWidth=container.current.clientWidth
    let resizeRevision=0
    const observer=new ResizeObserver(()=>{
      const width=container.current?.clientWidth??0
      if(!width||width===lastWidth){chart.resize();return}
      const saved=chart.getVisibleRange();const data=chart.getDataList();const span=Math.max(1,saved.to-saved.from)
      const anchor=data[Math.max(0,Math.min(data.length-1,Math.floor((saved.from+saved.to)/2)))]?.timestamp
      const revision=++resizeRevision
      lastWidth=width;restoring.current=true;chart.resize()
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(chartRef.current!==chart||revision!==resizeRevision)return
        if(anchor){const plotWidth=chart.getSize('candle_pane','main')?.width??width;chart.setBarSpace(Math.max(1,plotWidth/span));restoreAnchor(chart,anchor)}
        restoring.current=false;saveViewport()
      }))
    }); observer.observe(container.current)
    chart.subscribeAction('onScroll',saveViewport); chart.subscribeAction('onZoom',saveViewport)
    const owner=container.current
    return ()=>{ generation.current++; saveViewport(); observer.disconnect(); chart.unsubscribeAction('onScroll',saveViewport); chart.unsubscribeAction('onZoom',saveViewport); dispose(owner); chartRef.current=null }
  },[])
  useEffect(()=>{
    const request=++generation.current; setLoading(true);setError('');setChooser(null)
    if(loadedKey.current!==key){
      candlesRef.current=[];setCandles([])
      chartRef.current?.setDataLoader({getBars:({callback})=>callback([],{forward:false,backward:false})})
    }
    if(props.barTime!=null&&(!Number.isFinite(props.barTime)||props.barTime<=0)){setError('No captured chart timestamp is available for this snapshot');setLoading(false);return}
    void (async()=>{
      let rows:OHLCCandle[]
      if(props.right&&props.strike&&props.expiry) rows=(await api.getOptionsHistorical(props.symbol,props.date,props.strike,props.expiry,props.right,3,Math.max(1,historicalDays))).candles
      else { const [history,day]=await Promise.all([api.getHistorical(props.symbol,props.date,3,historicalDays),api.getPreSession(props.symbol,props.date,'15:30:00',3)]); rows=[...history.candles,...day] }
      if(request!==generation.current)return
      if(historicalDays===0) rows=rows.filter(c=>new Date(c.time*1000).toISOString().slice(0,10)===props.date)
      const sorted=snapshotCandles(rows,props.barTime,props.barOhlc)

      loadedKey.current=key;candlesRef.current=sorted;setCandles(sorted);setLoading(false)
      const chart=chartRef.current;if(!chart)return
      chart.setSymbol({ticker:props.symbol,pricePrecision:2,volumePrecision:0});chart.setPeriod({span:3,type:'minute'})
      chart.setDataLoader({getBars:({type,callback})=>callback(type==='init'?sorted.map(c=>({timestamp:c.time*1000,open:c.open,high:c.high,low:c.low,close:c.close} satisfies KLineData)):[],{forward:false,backward:false})})
      requestAnimationFrame(()=>{if(request!==generation.current||chartRef.current!==chart)return; const saved=viewports.get(key);chart.setBarSpace(saved?.barSpace??Math.max(2,(container.current?.clientWidth??800)/Math.min(150,Math.max(1,sorted.length)))); if(saved)restoreAnchor(chart,saved.anchor);else chart.scrollToRealTime(0)})
    })().catch(e=>{if(request===generation.current){setError(String(e));setLoading(false)}})
  },[api,key,historicalDays,props.barOhlc,refresh])
  useEffect(()=>{
    const chart=chartRef.current;if(!chart)return
    overlays.current.forEach(id=>chart.removeOverlay({id}));overlays.current=[]
    if(!candles.length)return
    for(const marker of markersRef.current){
      const id=chart.createOverlay({name:'analysisExecution',id:`execution:${marker.key}`,lock:true,points:[{timestamp:marker.timestamp*1000,value:marker.price}],extendData:marker,
        onClick:event=>{
          // Neighbouring bars can overlap on screen even when timestamps differ.
          // Offer every physical execution under the hit area, never hide one
          // behind the last-drawn circle. Different price levels remain separate.
          const nearby = Number.isFinite(event.x)&&Number.isFinite(event.y) ? markersRef.current.filter(candidate=>{
            const point=chart.convertToPixel({timestamp:candidate.timestamp*1000,value:candidate.price})
            return !Array.isArray(point)&&typeof point.x==='number'&&typeof point.y==='number'&&Math.hypot(point.x-(event.x??0),point.y-(event.y??0))<=9
          }) : [marker]
          const rows=(nearby.length?nearby:[marker]).flatMap(candidate=>candidate.trades).sort((a,b)=>(a.execution_sort_time??a.timestamp*1e6)-(b.execution_sort_time??b.timestamp*1e6)||a.trade_id.localeCompare(b.trade_id))
          if(rows.length>1)setChooser({...marker,trades:rows,approximate:nearby.some(candidate=>candidate.approximate)})
          else { const trade=rows[0];if(trade.session_id)selectRef.current?.(trade);else setUnavailableSnapshot(trade) }
          return true
        }})
      if(typeof id==='string')overlays.current.push(id)
    }
    const annotations=(props.annotations??[]).filter(a=>props.right?a.instrument===props.right:a.instrument==='underlying')

    annotations.sort((a,b)=>a.time-b.time).forEach(a=>{const style=buildMarkers([a],props.activeStrategy??null,props.activeCategory??null,props.topPatterns)[0];const id=chart.createOverlay({name:'analysisAnnotation',lock:true,points:[{timestamp:a.time*1000,value:a.price}],extendData:{color:style?.color??'#fbbf24',text:`${a.type==='entry'?'↑':'↓'} ${style?.text??a.text}`}});if(typeof id==='string')overlays.current.push(id)})
    const levels=[...(props.openOrders??[]).map(order=>({price:order.trigger_price||order.limit_price,text:`${order.side} ${order.order_type} ${order.quantity}`})), ...(props.position?[{price:props.position.avg_entry_price,text:`Captured ${props.position.side} ${props.position.quantity}`}]:[]), ...(props.barTime!=null&&props.currentPrice!=null?[{price:props.currentPrice,text:'Captured current price'}]:[])]
    for(const order of levels){const price=order.price;if(!price||!candles.length)continue;const id=chart.createOverlay({name:'analysisLevel',lock:true,points:[{timestamp:candles[candles.length-1].time*1000,value:price}],extendData:{text:order.text}});if(typeof id==='string')overlays.current.push(id)}
  },[candles,filter,trades,props.annotations,props.activeStrategy,props.activeCategory,props.topPatterns,props.openOrders,props.position,props.currentPrice])
  return <section aria-label={`${props.title??props.right??'Underlying'} chart`} className={`desktop-analysis-chart ${props.isMaximized?'maximized':''}`}>
    <header><strong>{props.title??(props.right?`${props.right} ${props.strike} · ${props.expiry}`:'Underlying')} · 3m · IST</strong>
      {!props.right&&trades.some(t=>t.right)&&<select aria-label="Underlying markers" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All</option><option>CE</option><option>PE</option></select>}
      <button onClick={()=>{const chart=chartRef.current;if(chart&&container.current){chart.setBarSpace(Math.max(1,container.current.clientWidth/Math.max(1,candles.length)));chart.scrollToRealTime(0)}}}>Fit</button>
      {(props.onMaximize||props.onMax)&&<button aria-label={props.isMaximized?'Restore chart':'Maximize chart'} onClick={props.onMaximize??props.onMax}>{props.isMaximized?'Restore':'Maximize'}</button>}
    </header>
    <div ref={container} className="analysis-kline" />
    {loading&&<div role="status">Loading candles…</div>}{error&&<div role="alert">{error}<button onClick={()=>setRefresh(n=>n+1)}>Retry</button></div>}
    {chooser&&<div className="analysis-marker-chooser" role="dialog" aria-label="Choose execution"><button onClick={()=>setChooser(null)}>Close</button>{chooser.approximate&&<p>Underlying marker price is an approximate candle close.</p>}{chooser.trades.map(t=><button key={`${t.session_id}:${t.trade_id}`} onClick={()=>{setChooser(null);if(t.session_id)selectRef.current?.(t);else setUnavailableSnapshot(t)}}>{new Date(t.timestamp*1000).toISOString().slice(11,19)} · {t.side} · {t.quantity} @ {t.price}</button>)}</div>}
    {unavailableSnapshot&&<div className="analysis-marker-chooser" role="dialog"><button onClick={()=>setUnavailableSnapshot(null)}>Close</button><p>Captured snapshot execution · {unavailableSnapshot.side} {unavailableSnapshot.quantity} @ {unavailableSnapshot.price}</p><p>Execution provenance not captured.</p></div>}
    {props.barTime!=null&&<small className="analysis-snapshot-caption">Recorded boundary {props.observationResolution ? `${props.observationResolution}s observation` : 'evidence (resolution unknown)'}; cached prices after capture are excluded.</small>}
    {!props.right&&markers.some(m=>m.approximate)&&<small>Some underlying markers use approximate candle closes. Option fill prices remain exact.</small>}
  </section>
}
interface ComparisonProps extends Props { strikeTabs?: Array<{key:string;label:string;right:string;strike:number;expiry:string;trades:AnalysisTrade[]}>; patternStrike?:{ce:number|null;pe:number|null;exp:string|null}; isOpt?:boolean; instFilter?:string; setInstFilter?:(value:'underlying'|'CE'|'PE')=>void }
export function ComparisonChart(props: ComparisonProps) {
  const [maximized,setMaximized]=useState(false)
  useEffect(()=>{if(!maximized)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setMaximized(false)};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[maximized])
  const tabs=useMemo(()=>contractTabs(props.trades??[]),[props.trades])
  const [active,setActive]=useState('');const tab=tabs.find(t=>t.key===active)
  const environment=useAnalysisEnvironment()
  useEffect(()=>{environment.onSelectionContextChange?.()},[active,props.instFilter])
  const isPattern=Boolean(props.annotations)
  const right=isPattern?(props.instFilter==='CE'||props.instFilter==='PE'?props.instFilter:undefined):tab?.right
  const strike=isPattern?(right==='CE'?props.patternStrike?.ce:props.patternStrike?.pe):tab?.strike
  const expiry=isPattern?props.patternStrike?.exp:tab?.expiry
  return <div className={`analysis-comparison-chart ${maximized?'comparison-chart-maximized':''}`}><nav><button onClick={()=>{setActive('');props.setInstFilter?.('underlying')}}>Underlying</button>{isPattern?(['CE','PE']as const).filter(r=>r==='CE'?props.patternStrike?.ce:props.patternStrike?.pe).map(r=><button key={r} onClick={()=>props.setInstFilter?.(r)}>{r}</button>):tabs.map(t=><button key={t.key} onClick={()=>setActive(t.key)}>{t.label} · {t.expiry}</button>)}</nav><DesktopAnalysisChart {...props} isMaximized={maximized} onMax={()=>setMaximized(n=>!n)} trades={tab?.trades??props.trades} right={right} exchange={tab?.exchange} product={tab?.product} strike={strike??undefined} expiry={expiry??undefined}/></div>
}

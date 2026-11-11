import { ToolbarIcon } from './ToolbarIcon'
import { CandleInterval } from '../CandleInterval'
import { contractTabs } from './analysisContracts'
import { snapshotCandles, snapshotBarTime, resolveSnapshotExecutions } from './analysisSnapshot'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { init, dispose, registerOverlay, type Chart, type KLineData } from 'klinecharts'
import type { AnalysisTrade, OHLCCandle, PatternAnnotation, TopPatterns } from '../api'
import { useAnalysisApi, useAnalysisEnvironment } from '../environment'
import { buildMarkers } from '../patternMarkers'
import { analysisMarkers, type ExecutionMarker } from './analysisMarkers'
import { analysisDrawingInstrument } from '../../charts/klineDrawingModel'
import { useKLineDrawings } from '../../charts/useKLineDrawings'
import { ensureKLineExtensions, useKLineIndicators } from '../../charts/useKLineIndicators'
import { KLineIndicatorMenu, KLineToolsRail, useToolsRailVisible } from '../../charts/KLineToolsPanel'

interface Props {
  /** Hosts with little vertical room (the phone) put their own controls at the start of the chart's header row. */
  toolbarStart?: ReactNode
  /**
   * Live: the host supplies the whole candle series (history plus ticks) and updates it as ticks arrive; the chart then
   * fetches nothing itself. Candles that only change in the last bar are pushed incrementally.
   */
  liveCandles?: OHLCCandle[]
  /** What If: while true a click or tap on the chart reports the time and price under it (and is not passed on to the chart). Escape cancels. */
  pickMode?: boolean
  onPick?: (point: { time: number; price: number }) => void
  onPickCancel?: () => void
  pickHint?: string
  /** What If: edited legs drawn as hollow rings; those whose option side and strike match this chart (or equity on the underlying) show. */
  whatIfMarkers?: Array<{ key: string; time: number; price: number; side: 'BUY' | 'SELL'; text: string; removed: boolean; right: string | null; strike: number | null }>
  symbol: string; date: string; trades?: AnalysisTrade[]; historicalDays?: number
  exchange?: string; product?: string;
  strike?: number; expiry?: string; right?: string; title?: string; isMaximized?: boolean
  onMaximize?: () => void; onMax?: () => void; getMarkerText?: (trade: AnalysisTrade, forOption?: boolean) => string
  /** Epoch seconds to centre the chart on (e.g. the round trip being labeled). Zoom is kept. */
  focusTime?: number
  /** Show `getMarkerText` on option-contract markers (they are unlabeled by default). */
  labelContractMarkers?: boolean
  observationResolution?: number; snapshotEventId?: string; snapshotEventTime?: number;
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
      ...(marker.text ? [{type:'text',attrs:{x:point.x,y:point.y-9,text:marker.text,align:'center',baseline:'bottom'},styles:{color:marker.color,size:11,weight:'bold'},ignoreEvent:false}] : []),
    ] },
  })
  registerOverlay({ name: 'analysisWhatIf', totalStep: 1, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    createPointFigures: ({coordinates,overlay}) => { const point=coordinates[0]; if(!point) return []; const marker=overlay.extendData as {color:string;text:string;removed:boolean}; return [
      {type:'circle',attrs:{x:point.x,y:point.y,r:marker.removed?5:8},styles:{color:'transparent',borderColor:marker.color,borderSize:2,style:marker.removed?'stroke_fill':'stroke',borderStyle:marker.removed?'dashed':'solid'},ignoreEvent:true},
      {type:'text',attrs:{x:point.x,y:point.y+11,text:marker.text,align:'center',baseline:'top'},styles:{color:marker.color,size:11,weight:'bold'},ignoreEvent:true},
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
  const intervalMinutes=environment.intervalMinutes??3
  const historicalDays=props.historicalDays??environment.historicalDays??2
  const container=useRef<HTMLDivElement>(null); const chartRef=useRef<Chart|null>(null)
  const pickRef=useRef({active:false,onPick:props.onPick,onCancel:props.onPickCancel}); pickRef.current={active:!!props.pickMode,onPick:props.onPick,onCancel:props.onPickCancel}
  const whatIfOverlays=useRef<string[]>([])
  const candlesRef=useRef<OHLCCandle[]>([]); const overlays=useRef<string[]>([])
  const [candles,setCandles]=useState<OHLCCandle[]>([]); const [error,setError]=useState(''); const [loading,setLoading]=useState(true); const [refresh,setRefresh]=useState(0)
  const [filter,setFilter]=useState('all'); const [chooser,setChooser]=useState<ExecutionMarker|null>(null)
  const [unavailableSnapshot,setUnavailableSnapshot]=useState<AnalysisTrade|null>(null)
  const barTime=snapshotBarTime(props.snapshotEventTime,props.barTime,props.date,intervalMinutes)
  const chartKey=`${props.sessionId??props.trades?.[0]?.session_id??'chart'}:${props.exchange??''}:${props.product??''}:${props.symbol}:${props.date}:${props.right??'underlying'}:${props.strike??''}:${props.expiry??''}:${intervalMinutes}`
  const key=`${chartKey}:${barTime??''}:${props.snapshotEventId??''}:${props.snapshotEventTime??''}`
  const keyRef=useRef(chartKey); keyRef.current=chartKey
  const loadedKey=useRef<string|null>(null)
  const loadedEventKey=useRef<string|null>(null)
  const snapshotPending=barTime!=null&&loadedEventKey.current!==key
  const selectRef=useRef(environment.onSelectExecution); selectRef.current=environment.onSelectExecution
  const focusRef=useRef(props.focusTime); focusRef.current=props.focusTime
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
  const markers=analysisMarkers(trades,candles,contract,filter,props.getMarkerText,intervalMinutes,props.labelContractMarkers)
  const markersRef=useRef(markers); if(!snapshotPending&&(!loading||barTime==null))markersRef.current=markers
  const saveViewport=()=>{ const chart=chartRef.current; if(!chart||!candlesRef.current.length||restoring.current)return; const range=chart.getVisibleRange(); const index=Math.max(0,Math.min(candlesRef.current.length-1,Math.floor((range.from+range.to)/2))); viewports.set(loadedKey.current??keyRef.current,{barSpace:chart.getBarSpace().bar,anchor:candlesRef.current[index].time*1000}); while(viewports.size>32)viewports.delete(viewports.keys().next().value!) }
  useEffect(()=>{
    if(!container.current)return
    ensureKLineExtensions(); registerAnalysisOverlays(); const chart=init(container.current); if(!chart)return
    chartRef.current=chart; chart.setTimezone('Etc/UTC'); chart.setStyles('dark'); chart.setStyles({candle:{tooltip:{showRule:chartInfoRef.current}},indicator:{tooltip:{showRule:chartInfoRef.current}}}); chart.setSymbol({ticker:props.symbol,pricePrecision:2,volumePrecision:0}); chart.setPeriod({span:intervalMinutes,type:'minute'})
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
    // What If: while picking, a click reports the time and price under it, before the chart's own handlers (marker chooser) see it.
    const onPickClick=(event:MouseEvent)=>{
      const pick=pickRef.current; if(!pick.active||!pick.onPick)return
      const box=owner.getBoundingClientRect()
      const converted=chart.convertFromPixel([{x:event.clientX-box.left,y:event.clientY-box.top}],{paneId:'candle_pane'})
      const point=Array.isArray(converted)?converted[0]:converted
      if(!point||typeof point.value!=='number'||!Number.isFinite(point.value)||point.value<=0)return
      event.stopPropagation();event.preventDefault()
      pick.onPick({time:Math.round((point.timestamp??0)/1000),price:Math.round(point.value*100)/100})
    }
    owner.addEventListener('click',onPickClick,true)
    return ()=>{ owner.removeEventListener('click',onPickClick,true); generation.current++; saveViewport(); observer.disconnect(); chart.unsubscribeAction('onScroll',saveViewport); chart.unsubscribeAction('onZoom',saveViewport); dispose(owner); chartRef.current=null }
  },[])
  // Drawing tools + indicators. Declared after the chart-creation effect so chartRef is set when they first run.
  // undefined = resolving, null = no resolver (use defaults), false = lookup failed (tools disabled rather than saved under a guessed key)
  const [symbolInfo,setSymbolInfo]=useState<{kind:string;exchange:string}|null|false|undefined>(undefined)
  useEffect(()=>{
    let live=true; setSymbolInfo(undefined)
    const resolve=environment.resolveSymbolInstrument
    if(!resolve){setSymbolInfo(null);return}
    void resolve(props.symbol).then(value=>{if(live)setSymbolInfo(value??null)}).catch(error=>{if(live){setSymbolInfo(false);environment.reportError?.(String(error),'Drawings')}})
    return()=>{live=false}
  },[props.symbol,environment.resolveSymbolInstrument])
  const drawingInstrument=useMemo(()=>environment.drawingRequest&&symbolInfo!==undefined&&symbolInfo!==false?analysisDrawingInstrument({symbol:props.symbol,right:props.right,strike:props.strike,expiry:props.expiry,kind:symbolInfo?.kind,exchange:symbolInfo?.exchange}):null,[environment.drawingRequest,symbolInfo,props.symbol,props.right,props.strike,props.expiry])
  const [hovered,setHovered]=useState(false)
  const drawings=useKLineDrawings({chartRef,instrument:drawingInstrument,request:environment.drawingRequest,active:hovered&&environment.active!==false,onError:error=>environment.reportError?.(String(error),'Drawings')})
  // Details over the chart follow the environment setting (default: always, as before).
  const chartInfo=environment.chartInfo??'always'; const chartInfoRef=useRef(chartInfo); chartInfoRef.current=chartInfo
  useEffect(()=>{chartRef.current?.setStyles({candle:{tooltip:{showRule:chartInfo}},indicator:{tooltip:{showRule:chartInfo}}})},[chartInfo])
  const indicators=useKLineIndicators(chartRef,`analysis-kline-indicators:${environment.accountKey??''}:${props.right?'option':'underlying'}`,{hasVolume:candles.some(c=>c.volume!=null)})
  const [toolsVisible,toggleTools]=useToolsRailVisible()
  const toolsAvailable=Boolean(environment.drawingRequest)
  useEffect(()=>{
    if(props.liveCandles)return
    const controller=new AbortController()
    const request=++generation.current; setLoading(true);setError('');setChooser(null)
    const clearCandles=()=>{
      candlesRef.current=[];setCandles([]);loadedKey.current=null
      chartRef.current?.setDataLoader({getBars:({callback})=>callback([],{forward:false,backward:false})})
    }
    if(loadedKey.current!==chartKey)clearCandles()
    if(barTime!=null&&(!Number.isFinite(barTime)||barTime<=0)){
      setError('No captured chart timestamp is available for this snapshot');setLoading(false);loadedEventKey.current=key;clearCandles()
      return () => controller.abort()
    }
    void (async()=>{
      let rows:OHLCCandle[]
      if(props.right&&props.strike&&props.expiry) rows=(await api.getOptionsHistorical(props.symbol,props.date,props.strike,props.expiry,props.right,intervalMinutes,Math.max(1,historicalDays))).candles
      else { const [history,day]=await Promise.all([api.getHistorical(props.symbol,props.date,intervalMinutes,historicalDays),api.getPreSession(props.symbol,props.date,'15:30:00',intervalMinutes)]); rows=[...history.candles,...day] }
      if(request!==generation.current)return
      if(historicalDays===0) rows=rows.filter(c=>new Date(c.time*1000).toISOString().slice(0,10)===props.date)
      let eventCandle:OHLCCandle|null=null
      if(intervalMinutes===3&&props.snapshotEventId&&props.sessionId&&api.getSnapshotCandle){
        try {
          eventCandle=(await api.getSnapshotCandle(props.sessionId,props.snapshotEventId,props.right==='CE'?'CE':props.right==='PE'?'PE':'underlying',controller.signal)).candle
        } catch(cause) {
          if(controller.signal.aborted)return
          console.warn('Snapshot candle reconstruction unavailable; using historical candle',cause)
        }
      }
      if(request!==generation.current||controller.signal.aborted)return
      const sorted=snapshotCandles(rows,barTime,eventCandle&&eventCandle.time===barTime?eventCandle:null)
      if(barTime!=null&&!sorted.some(c=>c.time===barTime))throw new Error('No candle data is available for the selected event')

      const chart=chartRef.current;if(!chart)return
      const continuing=barTime!=null&&loadedKey.current===chartKey&&candlesRef.current.length>0
      const range=chart.getVisibleRange()
      const anchor=candlesRef.current[Math.max(0,Math.min(candlesRef.current.length-1,Math.floor((range.from+range.to)/2)))]?.time
      const saved=continuing ? {barSpace:chart.getBarSpace().bar,anchor:(anchor??sorted[sorted.length-1].time)*1000} : viewports.get(chartKey)
      const anchorPoint=continuing&&saved ? chart.convertToPixel({timestamp:saved.anchor},{paneId:'candle_pane'}) : undefined
      const anchorX=anchorPoint&&!Array.isArray(anchorPoint) ? anchorPoint.x : undefined
      loadedKey.current=chartKey;loadedEventKey.current=key;candlesRef.current=sorted;setCandles(sorted);setLoading(false)
      if(!continuing){chart.setSymbol({ticker:props.symbol,pricePrecision:2,volumePrecision:0});chart.setPeriod({span:intervalMinutes,type:'minute'})}
      // Reuse the loader on event changes so KLine also retains a manual price scale.
      if(continuing)chart.resetData()
      else chart.setDataLoader({getBars:({type,callback})=>callback(type==='init'?candlesRef.current.map(c=>({timestamp:c.time*1000,open:c.open,high:c.high,low:c.low,close:c.close,...(c.volume!=null?{volume:c.volume}:{})} satisfies KLineData)):[],{forward:false,backward:false})})
      const restoreViewport=()=>{
        if(request!==generation.current||chartRef.current!==chart)return
        chart.setBarSpace(saved?.barSpace??Math.max(2,(container.current?.clientWidth??800)/Math.min(150,Math.max(1,sorted.length))))
        if(continuing){
          if(saved&&typeof anchorX==='number'){
            const point=chart.convertToPixel({timestamp:saved.anchor},{paneId:'candle_pane'})
            if(!Array.isArray(point)&&typeof point.x==='number')chart.scrollByDistance(anchorX-point.x,0)
          }
        } else if(focusRef.current!=null&&barTime==null){
          const bar=intervalMinutes*60
          restoreAnchor(chart,Math.floor(focusRef.current/bar)*bar*1000)
        } else if(saved&&barTime==null)restoreAnchor(chart,saved.anchor)
        else chart.scrollToRealTime(0)
      }
      // Restore in the same update; a later callback could undo a fresh user pan/zoom.
      if(continuing)restoreViewport()
      else requestAnimationFrame(restoreViewport)
    })().catch(e=>{if(request===generation.current){
      setError(String(e));setLoading(false);loadedEventKey.current=key
      if(barTime!=null)clearCandles()
    }})
    return () => { controller.abort(); generation.current++ }
  },[api,key,historicalDays,refresh])
  const subscribeBar=useRef<((bar:KLineData)=>void)|null>(null)
  useEffect(()=>{
    const live=props.liveCandles; const chart=chartRef.current
    if(!live||!chart)return
    const toBar=(c:OHLCCandle):KLineData=>({timestamp:c.time*1000,open:c.open,high:c.high,low:c.low,close:c.close,...(c.volume!=null?{volume:c.volume}:{})})
    const previous=candlesRef.current
    const sameBar=(a:OHLCCandle|undefined,b:OHLCCandle|undefined)=>!!a&&!!b&&a.time===b.time&&a.open===b.open&&a.high===b.high&&a.low===b.low&&a.close===b.close
    const incremental=loadedKey.current===chartKey&&previous.length>0&&live.length>0&&subscribeBar.current!==null&&live[0].time===previous[0].time
      &&(live.length===previous.length||live.length===previous.length+1)&&(live.length<2||sameBar(live[live.length-2],previous[live.length-2]))
    candlesRef.current=live;setCandles(live);setError('');setLoading(live.length===0)
    if(!live.length){loadedKey.current=null;chart.setDataLoader({getBars:({callback})=>callback([],{forward:false,backward:false})});return}
    if(incremental){subscribeBar.current!(toBar(live[live.length-1]));return}
    const first=loadedKey.current!==chartKey
    loadedKey.current=chartKey
    if(first){chart.setSymbol({ticker:props.symbol,pricePrecision:2,volumePrecision:0});chart.setPeriod({span:intervalMinutes,type:'minute'})}
    chart.setDataLoader({
      getBars:({type,callback})=>callback(type==='init'?candlesRef.current.map(toBar):[],{forward:false,backward:false}),
      subscribeBar:({callback})=>{subscribeBar.current=callback},
      unsubscribeBar:()=>{subscribeBar.current=null},
    })
    if(first)requestAnimationFrame(()=>{if(chartRef.current!==chart)return;chart.setBarSpace(Math.max(2,(container.current?.clientWidth??800)/Math.min(150,Math.max(1,live.length))));chart.scrollToRealTime(0)})
    else chart.resetData()
  },[props.liveCandles,chartKey])
  useEffect(()=>{
    if(!props.pickMode)return
    const escape=(event:KeyboardEvent)=>{ if(event.key==='Escape'){ event.stopPropagation(); pickRef.current.onCancel?.() } }
    window.addEventListener('keydown',escape,true); return()=>window.removeEventListener('keydown',escape,true)
  },[props.pickMode])
  useEffect(()=>{
    const chart=chartRef.current;if(!chart)return
    whatIfOverlays.current.forEach(id=>chart.removeOverlay({id}));whatIfOverlays.current=[]
    if(!candles.length)return
    const slot=intervalMinutes*60
    for(const marker of props.whatIfMarkers??[]){
      const here=props.right?marker.right===props.right&&marker.strike===(props.strike??null):marker.right==null
      if(!here)continue
      const id=chart.createOverlay({name:'analysisWhatIf',lock:true,points:[{timestamp:Math.floor(marker.time/slot)*slot*1000,value:marker.price}],extendData:{color:marker.side==='BUY'?'#f0b429':'#d36bff',text:marker.text,removed:marker.removed}})
      if(typeof id==='string')whatIfOverlays.current.push(id)
    }
  },[candles,props.whatIfMarkers,props.right,props.strike,intervalMinutes])
  // Re-centre when the requested time changes on an already loaded chart (Prev/Next in Label Trades).
  useEffect(()=>{
    const chart=chartRef.current
    if(!chart||props.focusTime==null||loading||loadedKey.current!==chartKey||!candlesRef.current.length)return
    const bar=intervalMinutes*60,slot=Math.floor(props.focusTime/bar)*bar
    const frame=requestAnimationFrame(()=>{if(chartRef.current===chart)restoreAnchor(chart,slot*1000)})
    return()=>cancelAnimationFrame(frame)
  },[props.focusTime])
  useEffect(()=>{
    const chart=chartRef.current;if(!chart||snapshotPending||(barTime!=null&&loading))return
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

    annotations.sort((a,b)=>a.time-b.time).forEach(a=>{const style=buildMarkers([a],props.activeStrategy??null,props.activeCategory??null,props.topPatterns)[0];const id=chart.createOverlay({name:'analysisAnnotation',lock:true,points:[{timestamp:Math.floor(a.time/(intervalMinutes*60))*(intervalMinutes*60)*1000,value:a.price}],extendData:{color:style?.color??'#fbbf24',text:`${a.type==='entry'?'↑':'↓'} ${style?.text??a.text}`}});if(typeof id==='string')overlays.current.push(id)})
    const levels=[...(props.openOrders??[]).map(order=>({price:order.trigger_price||order.limit_price,text:`${order.side} ${order.order_type} ${order.quantity}`})), ...(props.position?[{price:props.position.avg_entry_price,text:`Captured ${props.position.side} ${props.position.quantity}`}]:[]), ...(props.barTime!=null&&props.currentPrice!=null?[{price:props.currentPrice,text:'Captured current price'}]:[])]
    for(const order of levels){const price=order.price;if(!price||!candles.length)continue;const id=chart.createOverlay({name:'analysisLevel',lock:true,points:[{timestamp:candles[candles.length-1].time*1000,value:price}],extendData:{text:order.text}});if(typeof id==='string')overlays.current.push(id)}
  },[candles,loading,snapshotPending,filter,trades,props.annotations,props.activeStrategy,props.activeCategory,props.topPatterns,props.openOrders,props.position,props.currentPrice,intervalMinutes])
  return <section aria-label={`${props.title??props.right??'Underlying'} chart`} className={`desktop-analysis-chart ${props.isMaximized?'maximized':''} ${props.pickMode?'picking':''} ${toolsAvailable&&toolsVisible?'has-tools-rail':''}`} data-contract-labels={props.right?(props.labelContractMarkers?'on':'off'):undefined} onPointerEnter={()=>setHovered(true)} onPointerLeave={()=>setHovered(false)}>
    <header>{props.toolbarStart}<strong>{props.title??(props.right?`${props.right} ${props.strike} · ${props.expiry}`:'Underlying')} · {intervalMinutes}m · IST</strong>
      {!props.right&&trades.some(t=>t.right)&&<select aria-label="Underlying markers" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All</option><option>CE</option><option>PE</option></select>}
      <CandleInterval />
      {toolsAvailable&&<button className="kline-tools-toggle" type="button" aria-pressed={toolsVisible} aria-label={toolsVisible?'Hide drawing tools':'Show drawing tools'} title={toolsVisible?'Hide drawing tools':'Show drawing tools'} onClick={toggleTools}>✎</button>}
      <KLineIndicatorMenu names={indicators.names} toggle={indicators.toggle} clear={indicators.clear} />
      <button aria-label="Fit chart" title="Fit chart" onClick={()=>{const chart=chartRef.current;if(chart&&container.current){chart.setBarSpace(Math.max(1,container.current.clientWidth/Math.max(1,candles.length)));chart.scrollToRealTime(0)}}}><ToolbarIcon name="Fit" /></button>
      {(props.onMaximize||props.onMax)&&<button title={props.isMaximized?'Restore chart':'Maximize chart'} aria-label={props.isMaximized?'Restore chart':'Maximize chart'} onClick={props.onMaximize??props.onMax}><ToolbarIcon name={props.isMaximized?'Restore':'Maximize'} /></button>}
    </header>
    {toolsAvailable&&toolsVisible&&<KLineToolsRail drawings={drawings} />}
    {props.pickMode&&<div className="analysis-pick-hint" role="status">{props.pickHint??'Click the chart to set the price'} · Esc cancels</div>}
    <div ref={container} className="analysis-kline" />
    {barTime!=null&&intervalMinutes!==3&&<small>Full historical event candle</small>}
    {loading&&<div role="status">Loading candles…</div>}{error&&<div role="alert">{error}<button onClick={()=>setRefresh(n=>n+1)}>Retry</button></div>}
    {chooser&&<div className="analysis-marker-chooser" role="dialog" aria-label="Choose execution"><button onClick={()=>setChooser(null)}>Close</button>{chooser.approximate&&<p>Underlying marker price is an approximate candle close.</p>}{chooser.trades.map(t=><button key={`${t.session_id}:${t.trade_id}`} onClick={()=>{setChooser(null);if(t.session_id)selectRef.current?.(t);else setUnavailableSnapshot(t)}}>{new Date(t.timestamp*1000).toISOString().slice(11,19)} · {t.side} · {t.quantity} @ {t.price}</button>)}</div>}
    {unavailableSnapshot&&<div className="analysis-marker-chooser" role="dialog"><button onClick={()=>setUnavailableSnapshot(null)}>Close</button><p>Captured snapshot execution · {unavailableSnapshot.side} {unavailableSnapshot.quantity} @ {unavailableSnapshot.price}</p><p>Execution provenance not captured.</p></div>}
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
  return <div className={`analysis-comparison-chart ${maximized?'comparison-chart-maximized':''}`}><nav><button onClick={()=>{setActive('');props.setInstFilter?.('underlying')}}>Underlying</button>{isPattern?(['CE','PE']as const).filter(r=>r==='CE'?props.patternStrike?.ce:props.patternStrike?.pe).map(r=><button key={r} onClick={()=>props.setInstFilter?.(r)}>{r}</button>):tabs.map(t=><button key={t.key} title={`${t.right} ${t.strike} · ${t.expiry} · ${t.exchange??''} · ${t.product??''}`} onClick={()=>setActive(t.key)}>{t.label}</button>)}</nav><DesktopAnalysisChart {...props} isMaximized={maximized} onMax={()=>setMaximized(n=>!n)} trades={tab?.trades??props.trades} right={right} exchange={tab?.exchange} product={tab?.product} strike={strike??undefined} expiry={expiry??undefined}/></div>
}

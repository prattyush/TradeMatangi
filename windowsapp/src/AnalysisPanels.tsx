import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisTrade } from '../../shared/analysis/api'
import { useAnalysisEnvironment } from '../../shared/analysis/environment'
import DesktopAnalysisChart from './AnalysisChart'

import { contractTabs } from './analysisContracts'
export { contractTabs } from './analysisContracts'
export default function AnalysisPanels({ symbol, date, allTrades, historicalDays=2, getMarkerText }: {symbol:string;date:string;allTrades:AnalysisTrade[];historicalDays?:number;getMarkerText?:(t:AnalysisTrade)=>string}) {
  const environment = useAnalysisEnvironment()
  const tabs = useMemo(()=>contractTabs(allTrades),[allTrades])
  const [selected,setSelected] = useState('')
  const [pane,setPane] = useState<'underlying'|'option'>('underlying')
  const [max,setMax] = useState<'underlying'|'option'|null>(null)
  const [ratio,setRatio] = useState(50)
  const root = useRef<HTMLDivElement>(null)
  const tab = tabs.find(t=>t.key===selected) ?? tabs[0]
  useEffect(()=>{ setSelected(''); setMax(null); environment.onSelectionContextChange?.() },[symbol,date])
  useEffect(()=>{
    if (!max || !environment.active) return
    const escape=(e:KeyboardEvent)=>{ if(e.key==='Escape') setMax(null) }
    window.addEventListener('keydown',escape); return()=>window.removeEventListener('keydown',escape)
  },[max,environment.active])
  const drag=(clientX:number)=>{ const box=root.current?.getBoundingClientRect(); if(box)setRatio(Math.max(25,Math.min(75,100*(clientX-box.left)/box.width))) }
  return <div ref={root} className={`analysis-panels ${tabs.length?'has-options':''} ${max?'chart-maximized':''}`} data-pane={pane} data-max={max??''} style={{'--analysis-chart-split':`${ratio}%`} as React.CSSProperties}>
    {tabs.length>0 && <nav className="analysis-pane-navigation" aria-label="Chart pane"><button aria-pressed={pane==='underlying'} onClick={()=>setPane('underlying')}>Underlying</button><button aria-pressed={pane==='option'} onClick={()=>setPane('option')}>Option</button></nav>}
    <div className="analysis-underlying-pane" hidden={max==='option'}>
      {environment.active !== false && <DesktopAnalysisChart symbol={symbol} date={date} trades={allTrades} historicalDays={historicalDays} getMarkerText={getMarkerText} title="Underlying" isMaximized={max==='underlying'} onMaximize={()=>setMax(value=>value==='underlying'?null:'underlying')} />}
    </div>
    {tabs.length>0 && <>
      <div className="analysis-chart-separator" role="separator" aria-label="Resize chart split" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={ratio} tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setRatio(n=>Math.max(25,Math.min(75,n+(e.key==='ArrowLeft'?-5:5))))}}} onPointerDown={e=>e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))drag(e.clientX)}} />
      <div className="analysis-option-pane" hidden={max==='underlying'}><nav aria-label="Exact option contracts">{tabs.map(t=><button key={t.key} aria-pressed={tab?.key===t.key} onClick={()=>{setSelected(t.key);environment.onSelectionContextChange?.()}}>{t.label}</button>)}</nav>
        {tab && environment.active !== false && <DesktopAnalysisChart symbol={symbol} date={date} trades={tab.trades} right={tab.right} strike={tab.strike} expiry={tab.expiry} exchange={tab.exchange} product={tab.product} historicalDays={historicalDays} getMarkerText={getMarkerText} isMaximized={max==='option'} onMaximize={()=>setMax(value=>value==='option'?null:'option')} />}
      </div>
    </>}
  </div>
}

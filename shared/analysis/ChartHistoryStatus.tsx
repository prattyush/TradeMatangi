export type HistoryState = 'loading'|'ready'|'empty'|'error'
export function ChartHistoryStatus({state,interval,retry}:{state:HistoryState;interval:number;retry:()=>void}) {
  if(state==='ready')return null
  return <div role={state==='error'?'alert':'status'} style={{position:'absolute',top:32,left:8,zIndex:20,padding:'8px 12px',background:'#162030',color:'#e2e8f0',borderRadius:4}}>
    {state==='loading'?`Loading ${interval}m candles…`:state==='empty'?`No ${interval}m candles available.`:`Could not load ${interval}m candles.`}
    {state!=='loading'&&<button onClick={retry} style={{marginLeft:8}}>Retry candles</button>}
  </div>
}

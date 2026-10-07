import type { AnalysisTrade, OHLCCandle } from '../../shared/analysis/api'
export function snapshotCandles(rows:OHLCCandle[],barTime?:number,barOhlc?:Omit<OHLCCandle,'time'>|null):OHLCCandle[] {
  const result=barTime==null?rows:rows.filter(c=>c.time<barTime)
  // Never reuse the cached full boundary bar: it can contain prices after capture.
  if(barTime!=null&&barOhlc)result.push({time:barTime,...barOhlc})
  return [...new Map(result.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time)
}
export function resolveSnapshotExecutions(captured:AnalysisTrade[],canonical:AnalysisTrade[]):AnalysisTrade[] {
  return captured.map(trade=>{
    const matches=canonical.filter(row=>row.session_id===trade.session_id&&[row.execution_id,row.trade_id,row.stored_trade_id].filter(Boolean).includes(trade.execution_id??trade.trade_id))
    const row=matches.length===1?matches[0]:undefined
    return row&&row.quantity===trade.quantity&&row.price===trade.price ? {...row,underlying_price:trade.underlying_price??row.underlying_price} : {...trade,captured_only:true}
  })
}

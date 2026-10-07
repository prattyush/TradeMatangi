import type { AnalysisTrade, SessionDetail } from '../../shared/analysis/api'
import type { AnalyticsMetadata, PerformanceCycle } from '../../shared/analysis/performance'
import { executionRoles } from './analysisMarkers'

const text=(value:unknown):string => value==null || value==='' ? 'Unknown' : typeof value==='boolean' ? value?'Yes':'No' : typeof value==='number' ? value.toLocaleString('en-IN',{maximumFractionDigits:4}) : String(value)
const money=(value:unknown)=>typeof value==='number'?`₹${text(value)}`:text(value)
const pct=(value:unknown)=>typeof value==='number'?`${text(value)}%`:text(value)
const time=(value:number)=>new Date(value*1000).toISOString().replace('T',' ').slice(0,19)+' IST'
function Fields({rows}:{rows:Array<[string,unknown,((value:unknown)=>string)?]>}) { return <dl>{rows.map(([label,value,format])=><div key={label}><dt>{label}</dt><dd>{format?format(value):text(value)}</dd></div>)}</dl> }
function Analytics({meta}:{meta:AnalyticsMetadata|undefined}) {
  return <><Fields rows={[
    ['Original entry method',meta?.entry_method],['Execution type',meta?.execution_type],['Logical action',meta?.action_id],
    ['Sizing method',meta?.sizing_method],['Requested percentage',meta?.requested_pct,pct],['Requested budget',meta?.requested_budget,money],['Requested quantity',meta?.calculated_quantity],
    ['Captured capital',meta?.capital,money],['Sizing reference price',meta?.reference_price,money],['Initial sizing stop',meta?.initial_stop,money],['Stop source',meta?.stop_source],['Lot size',meta?.lot_size],['Margin rate',meta?.margin_rate],
    ['Filled quantity',meta?.filled_quantity],['Filled value',meta?.filled_value,money],['Effective allocation',meta?.effective_allocation_pct,pct],['Initial monetary risk',meta?.initial_risk,money],['Effective risk',meta?.effective_risk_pct,pct],['Minimum-lot budget overrun',meta?.budget_exceeded],
    ['Confirmed exit method',meta?.exit_method],['Requested Half / Full',meta?.requested_size],['Selected exit quantity',meta?.selected_quantity],['Position quantity at selection',meta?.position_quantity],['Exit action ID',meta?.exit_action_id],['Original execution gap',meta?.execution_gap_pct,pct],['Attached entry stop',meta?.requested_entry_stop,money],['Strategy',meta?.strategy_id],
  ]}/>{meta?.controller_history && <details><summary>Confirmed controller history ({meta.controller_history.length})</summary>{meta.controller_history.map((item,i)=><Fields key={i} rows={Object.entries(item).map(([key,value])=>[key.replace(/_/g,' '),value])}/>)}</details>}</>
}
export default function ExecutionInspector({trade,detail,error,onRetry,onClose,onCycle}:{trade:AnalysisTrade;detail:SessionDetail|null;error:string;onRetry:()=>void;onClose:()=>void;onCycle:(cycle:PerformanceCycle)=>void}) {
  const canonical = trade.captured_only ? undefined : detail?.trades.find(row=>(row.execution_id||row.trade_id)===(trade.execution_id||trade.trade_id))
  const evidence = canonical ?? trade
  const roles = canonical ? executionRoles(canonical,detail?.cycles??[]) : []
  const action=canonical?.analytics?.action_id
  const actionTrades=action ? detail?.trades.filter(row=>row.analytics?.action_id===action) : undefined
  const exitAction=canonical?.analytics?.exit_action_id
  const exitRows=exitAction ? detail?.cycles?.flatMap(c=>c.executions).filter(row=>row.role==='exit'&&row.analytics?.exit_action_id===exitAction) : undefined
  return <aside className="analysis-execution-inspector" role="dialog" aria-label="Execution inspector"><header><strong>{evidence.side} {evidence.quantity} @ {evidence.price}</strong><button onClick={onClose}>Close</button></header>
    {error&&<p role="alert">{error}<button onClick={onRetry}>Retry</button></p>}{!detail&&!error&&<p role="status">Reading stored evidence…</p>}
    <section><h3>Execution</h3><Fields rows={[
      ['Contract',`${evidence.symbol}${evidence.right?` ${evidence.right} ${evidence.strike??'Unknown strike'} · ${evidence.expiry??'Unknown expiry'}`:''}`],['Exchange',evidence.exchange],['Product',evidence.product],['Time',time(evidence.timestamp)],['Side',evidence.side],['Filled quantity',evidence.quantity],['Lots',typeof evidence.analytics?.lot_size==='number'?evidence.quantity/evidence.analytics.lot_size:undefined],['Fill price',evidence.price,money],['Fill value',evidence.price*evidence.quantity,money],['Estimated fees',evidence.commission,money],['Session',evidence.session_id],['Account',detail?.owner_email??detail?.user_id],['Mode',detail?.session_type],['Execution ID',evidence.execution_id??evidence.trade_id],['Application order ID',evidence.order_id],['Broker order ID',evidence.kotak_order_id],['Client/source',evidence.source],
    ]}/></section>
    {!canonical&&detail&&<p>Captured snapshot evidence only. No canonical execution ID match; cycle provenance is unavailable.</p>}
    <section><h3>Captured intent and sizing</h3><Analytics meta={evidence.analytics}/></section>
    {actionTrades&&<section><h3>Logical action totals</h3><Fields rows={[["Physical fills",actionTrades.length],["Action quantity",actionTrades.reduce((sum,row)=>sum+row.quantity,0)],["Action fill value",actionTrades.reduce((sum,row)=>sum+row.price*row.quantity,0),money]]}/></section>}
    {exitRows&&<section><h3>Confirmed exit action totals</h3><Fields rows={[["Matched exit fills",exitRows.length],["Actual exit quantity",exitRows.reduce((sum,row)=>sum+row.quantity,0)],["Actual exit value",exitRows.reduce((sum,row)=>sum+row.quantity*row.price,0),money]]}/></section>}
    {roles.map(({cycle,row},index)=>{
      const matches=cycle.matches.filter(match=>(match.entry_execution_id??match.entry_id)===(evidence.execution_id??evidence.trade_id)||(match.exit_execution_id??match.exit_id)===(evidence.execution_id??evidence.trade_id))
      return <section key={`${cycle.cycle_id}:${index}`}><h3>FIFO {row.role??'Unknown role'} · {row.quantity}</h3><button onClick={()=>onCycle(cycle)}>Open cycle</button><Fields rows={[["Role quantity",row.quantity],["Role fees",row.commission,money],["Matched net P&L",matches.reduce((sum,match)=>sum+match.net_pnl,0),money],["Closed fraction",row.role==='exit'&&typeof row.analytics?.position_quantity==='number'&&row.analytics.position_quantity>0?row.quantity/row.analytics.position_quantity*100:undefined,pct]]}/>
        {matches.map((match,i)=><details key={i}><summary>{match.quantity} @ {match.entry_price} → {match.exit_price} · net {money(match.net_pnl)}</summary><Fields rows={[["Entry execution",match.entry_execution_id??match.entry_id],["Exit execution",match.exit_execution_id??match.exit_id],["Gross P&L",match.gross_pnl,money],["Net P&L",match.net_pnl,money],["Captured capital",match.capital,money],["Capital contribution",match.pnl_pct,pct],["Initial monetary risk",match.initial_risk,money],["Allocated fees",match.fees,money],["Initial-risk R",match.r_multiple],["Excursion status",match.excursion?.status],["MFE",match.excursion?.mfe,money],["MAE",match.excursion?.mae,money],["Giveback",match.excursion?.giveback,money],["Provider",match.excursion?.provider],["Sampling resolution (seconds)",match.excursion?.interval_seconds],["Coverage",typeof match.excursion?.coverage==='number'?match.excursion.coverage*100:undefined,pct],["Unavailable reason",match.excursion?.reason]]}/></details>)}
        <h4>Associated cycle result</h4><Fields rows={[["Direction",cycle.direction],["State",cycle.state],["Net P&L",cycle.net_pnl,money],["Capital contribution",cycle.pnl_pct,pct],["Estimated fees",cycle.fees,money],["Open quantity",cycle.open_quantity],["Excursion status",cycle.excursion?.status]]}/><p>Cycle context overlaps across executions and must not be added. Open cycle offers explicit cached price-path analysis.</p>
        {cycle.label&&<><h4>Saved labels</h4><Fields rows={Object.entries(cycle.label).map(([key,value])=>[key.replace(/_/g,' '),value])}/></>}
      </section>
    })}
  </aside>
}

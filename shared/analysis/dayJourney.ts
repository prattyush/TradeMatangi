import type { PerformanceCycle } from './performance'
export interface JourneyMember {cycle_id:string;session_id:string;label:string;delta:number;delta_pct:number|null}
export interface JourneyPoint { members:JourneyMember[];grouped:boolean; time:number;cycle_id:string;session_id:string;label:string;delta:number;delta_pct:number|null;pnl:number;pnl_pct:number|null;drawdown:number }
export interface JourneyCurve {completed:number;capital:number|null;sessions:number;points:JourneyPoint[];open_cycles:number}
export interface SizingBucket {entries:number;allocation_count:number;risk_count:number;median_allocation_pct:number|null;median_risk_pct:number|null}
export interface DayPath extends JourneyCurve {
  id:string;user_id?:string;date:string;mode:string;execution_broker?:string|null;broker_account_id?:string|null;
  completed:number;net_pnl:number;net_pnl_pct:number|null;max_drawdown:number;max_drawdown_pct:number|null;downward:number;downward_pct:number|null;giveback:number;giveback_pct:number|null;
  sizing:Record<'down'|'up'|'flat'|'unknown',SizingBucket>;sizing_ratio:{allocation:number|null;risk:number|null}
}
export function sessionJourney(cycles:PerformanceCycle[],capitals:Map<string,number>):JourneyCurve {
  const byId=new Map<string,PerformanceCycle>()
  for(const c of cycles){const key=`${c.user_id??''}:${c.cycle_id}`;if(!byId.has(key))byId.set(key,c)}
  const unique=[...byId.values()]
  const sessions=[...new Set(unique.map(c=>c.session_id))]
  const amounts=sessions.map(id=>capitals.get(id))
  const capital=amounts.length&&amounts.every(c=>c!=null&&Number.isFinite(c)&&c>0)?amounts.reduce<number>((sum,c)=>sum+c!,0)/amounts.length:null
  let balance=0,peak=0
  const closed=unique.filter(c=>c.state==='closed'&&c.exit_time!=null)
  const seconds=new Map<number,PerformanceCycle[]>()
  for(const c of closed){const rows=seconds.get(c.exit_time!)??[];rows.push(c);seconds.set(c.exit_time!,rows)}
  const batches:PerformanceCycle[][]=[]
  for(const [second,rows] of [...seconds.entries()].sort((a,b)=>a[0]-b[0])){
    const precise=rows.map(c=>c.exit_sort_time)
    const known=precise.every(v=>v!=null&&Number.isFinite(v)&&Math.floor(v/1e6)===second)&&new Set(precise).size===precise.length
    if(rows.length===1||known)batches.push(...rows.sort((a,b)=>(a.exit_sort_time??0)-(b.exit_sort_time??0)).map(c=>[c]))
    else batches.push(rows.sort((a,b)=>a.session_id.localeCompare(b.session_id)||a.cycle_id.localeCompare(b.cycle_id)))
  }
  const points=batches.map(rows=>{
    const members=rows.map(c=>({cycle_id:c.cycle_id,session_id:c.session_id,label:[c.symbol,c.right,c.strike].filter(v=>v!=null).join(' '),delta:c.net_pnl,delta_pct:capital?100*c.net_pnl/capital:null}))
    const delta=members.reduce((sum,c)=>sum+c.delta,0),first=members[0]
    balance+=delta;peak=Math.max(peak,balance)
    return {time:rows[0].exit_time!,cycle_id:first.cycle_id,session_id:first.session_id,label:members.length===1?first.label:`${members.length} same-second trades`,members,grouped:members.length>1,delta,delta_pct:capital?100*delta/capital:null,pnl:balance,pnl_pct:capital?100*balance/capital:null,drawdown:peak-balance}
  })
  return {capital,sessions:sessions.length,points,completed:closed.length,open_cycles:unique.filter(c=>c.state!=='closed').length}
}

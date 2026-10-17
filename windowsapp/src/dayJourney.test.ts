import { describe, expect, it } from 'vitest'
import { sessionJourney } from '../../shared/analysis/dayJourney'
import type { PerformanceCycle } from '../../shared/analysis/performance'
const cycle=(id:string,pnl:number,session='one',time=Number(id))=>({cycle_id:id,user_id:'u',session_id:session,exit_time:time,net_pnl:pnl,state:'closed',symbol:'NIFTY',right:'CE',strike:25000}) as PerformanceCycle

describe('combined day journey',()=>{
  it('accumulates completed trade returns with a fixed starting-capital denominator',()=>{
    const result=sessionJourney([cycle('1',4),cycle('2',-2),cycle('3',4)],new Map([['one',100]]))
    expect(result.points.map(p=>p.pnl_pct)).toEqual([4,2,6])
    expect(result.points.map(p=>p.delta_pct)).toEqual([4,-2,4])
    expect(result.points[1].drawdown).toBe(2)
  })
  it('averages each contributing session once, excludes empty sessions and deduplicates shared cycle identities',()=>{
    const rows=[cycle('1',100),cycle('2',100),cycle('3',100,'two'),cycle('1',100,'alias')]
    const result=sessionJourney(rows,new Map([['one',10000],['two',30000],['alias',10000],['empty',50000]]))
    expect(result.capital).toBe(20000)
    expect(result.sessions).toBe(2)
    expect(result.points).toHaveLength(3)
    expect(result.points[2].pnl_pct).toBe(1.5)
  })
  it('keeps partial/open cycles out, preserves net amounts and sorts completion order',()=>{
    const open={...cycle('2',99),state:'open',exit_time:null}
    const rows=[cycle('3',-5),open,cycle('1',10)]
    const result=sessionJourney(rows,new Map([['one',1000]]))
    expect(result.points.map(p=>p.pnl)).toEqual([10,5])
    expect(result.open_cycles).toBe(1)
    expect(rows[0].cycle_id).toBe('3')
  })
  it.each([0,-1,NaN,Infinity])('never invents percentages for invalid capital %s',capital=>{
    const result=sessionJourney([cycle('1',10)],new Map([['one',capital]]))
    expect(result.capital).toBeNull()
    expect(result.points[0].pnl).toBe(10)
    expect(result.points[0].pnl_pct).toBeNull()
  })
  it('handles missing capital and empty or unfinished days',()=>{
    expect(sessionJourney([],new Map()).points).toEqual([])
    expect(sessionJourney([cycle('1',10)],new Map()).capital).toBeNull()
    expect(sessionJourney([{...cycle('1',10),state:'open',exit_time:null}],new Map([['one',100]])).points).toEqual([])
  })
})

it('honors precise close order instead of the hash ordering within a second',()=>{
  const rows=[{...cycle('a',-5,'one',10),exit_sort_time:10_000_100},{...cycle('c',10,'one',10),exit_sort_time:10_000_200},{...cycle('b',-5,'one',10),exit_sort_time:10_000_300}]
  const path=sessionJourney(rows,new Map([['one',100]]))
  expect(path.points.map(p=>p.pnl)).toEqual([-5,5,0])
  expect(Math.max(...path.points.map(p=>p.drawdown))).toBe(5)
})
it.each([undefined,10_000_100])('groups missing or equal same-second precision (%s)',stamp=>{
  const rows=[cycle('a',-5,'one',10),cycle('c',10,'one',10),cycle('b',-5,'one',10)].map(c=>({...c,exit_sort_time:stamp}))
  const path=sessionJourney(rows,new Map([['one',100]]))
  expect(path.completed).toBe(3)
  expect(path.points).toHaveLength(1)
  expect(path.points[0].grouped).toBe(true)
  expect(path.points[0].pnl).toBe(0)
  expect(path.points[0].members.map(m=>m.cycle_id)).toEqual(['a','b','c'])
})

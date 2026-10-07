import { describe, it, expect, vi } from 'vitest'
import { AnalysisHistoryCache } from './analysisHistoryCache'
import { snapshotCandles, resolveSnapshotExecutions } from './analysisSnapshot'
import { completeCycleExport } from '../../shared/analysis/exportCycles'
import { contractTabs } from './analysisContracts'
import type { AnalysisTrade } from '../../shared/analysis/api'
import type { PerformanceCycle } from '../../shared/analysis/performance'
const trade=(extra:Partial<AnalysisTrade>={}):AnalysisTrade=>({trade_id:'one',session_id:'s',user_id:'a',symbol:'NIFTY',side:'BUY',quantity:40,price:100,timestamp:180,instrument_type:'options',right:'CE',strike:25000,expiry:'2026-10-08',commission:1,...extra})
const cycle=(id:string)=>({cycle_id:id,session_id:'s'}) as PerformanceCycle

describe('analysis history and exact contracts',()=>{
  it('coalesces histories, bounds candle count, and retries failures',async()=>{
    const cache=new AnalysisHistoryCache(2,3)
    const load=vi.fn().mockResolvedValue({candles:[1,2]})
    await cache.get('one',load);await cache.get('one',load);expect(load).toHaveBeenCalledTimes(1)
    await cache.get('two',()=>Promise.resolve({candles:[3,4]}))
    await cache.get('one',load);expect(load).toHaveBeenCalledTimes(2)
    const failed=vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue({candles:[]})
    await expect(cache.get('failed',failed)).rejects.toThrow('provider unavailable')
    await cache.get('failed',failed);expect(failed).toHaveBeenCalledTimes(2)
  })
  it('separates expiry, exchange and product even at the same strike',()=>{
    expect(contractTabs([trade(),trade({product:'MIS'}),trade({product:'CNC'}),trade({expiry:'2026-10-15'}),trade({exchange:'nse_fo'})])).toHaveLength(5)
  })
  it('never exposes the future portion of a snapshot boundary candle',()=>{
    const rows=[{time:0,open:100,high:101,low:99,close:100},{time:180,open:100,high:500,low:1,close:400}]
    expect(snapshotCandles(rows,180,null)).toEqual([rows[0]])
    expect(snapshotCandles(rows,180,{open:100,high:102,low:100,close:101})).toEqual([rows[0],{time:180,open:100,high:102,low:100,close:101}])
    expect(rows[1].high).toBe(500)
  })
  it('resolves only unique physical snapshot evidence without guessed expiry',()=>{
    const captured=trade({expiry:null})
    expect(resolveSnapshotExecutions([captured],[trade()])[0].expiry).toBe('2026-10-08')
    expect(resolveSnapshotExecutions([captured],[trade(),trade({trade_id:'two',stored_trade_id:'one'})])[0].captured_only).toBe(true)
    expect(resolveSnapshotExecutions([captured],[trade({quantity:20})])[0].captured_only).toBe(true)
    expect(resolveSnapshotExecutions([captured],[trade({session_id:'other'})])[0].captured_only).toBe(true)
  })
})
describe('complete CSV traversal',()=>{
  it('collects every page and rejects incomplete, duplicate and looping pagination',async()=>{
    expect(await completeCycleExport([cycle('a')],1,2,async()=>({items:[cycle('b')],total:2,next_offset:null}))).toHaveLength(2)
    await expect(completeCycleExport([cycle('a')],1,2,async()=>({items:[],total:2,next_offset:null}))).rejects.toThrow('incomplete')
    await expect(completeCycleExport([cycle('a')],1,2,async()=>({items:[cycle('a')],total:2,next_offset:null}))).rejects.toThrow('Duplicate')
    await expect(completeCycleExport([cycle('a')],1,3,async()=>({items:[cycle('b')],total:3,next_offset:1}))).rejects.toThrow('pagination changed')
    await expect(completeCycleExport([cycle('a')],null,2,async()=>{throw new Error('must not load')})).rejects.toThrow('incomplete')
  })
  it('does not export when the API fails or the query is cancelled',async()=>{
    await expect(completeCycleExport([cycle('a')],1,2,async()=>{throw new Error('read failed')})).rejects.toThrow('read failed')
    const controller=new AbortController();controller.abort()
    await expect(completeCycleExport([cycle('a')],1,2,async()=>({items:[cycle('b')],total:2,next_offset:null}),controller.signal)).rejects.toMatchObject({name:'AbortError'})
  })
})

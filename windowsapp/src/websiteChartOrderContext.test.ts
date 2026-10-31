import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartEntryError, chartMarketPrice, matchesChartContract, runChartOrderBatch, underlyingOptionsChart } from '../../frontend/src/services/chartOrderContext';
import { chartPaneHeight } from '../../frontend/src/services/chartLayout';
import { checkedChartCandles } from '../../frontend/src/services/klineCandles';
import api from '../../frontend/src/services/api';
const option={type:'options',right:'CE',strike:24000,expiry:'2026-10-20'};
const session={instrumentType:'options',sessionType:'sim',strikeCE:24000,strikePE:23900,expiry:'2026-10-20'};
afterEach(()=>vi.unstubAllGlobals());
describe('chart order contract routing',()=>{
  it('requires an option chart instead of assigning CE/PE to an underlying price',()=>{
    expect(underlyingOptionsChart({type:'equity'},'options')).toBe(true);
    expect(chartEntryError({type:'equity'},session)).toMatch(/CE\/PE chart/);
    expect(chartEntryError({type:'equity'},{...session,instrumentType:'equity'})).toBeNull();
  });
  it.each(['sim','stepwise','paper'])('keeps %s entries on actively streamed exact contracts',sessionType=>{
    expect(chartEntryError(option,{...session,sessionType})).toBeNull();
    expect(chartEntryError({...option,right:'PE',strike:23900},{...session,sessionType})).toBeNull();
    expect(chartEntryError({...option,strike:24100},{...session,sessionType})).toMatch(/actively streamed/);
    expect(chartEntryError({...option,expiry:'2026-10-27'},{...session,sessionType})).toMatch(/actively streamed/);
  });
  it('leaves other Real contracts to existing authoritative server validation',()=>{
    expect(chartEntryError({...option,strike:24100},{...session,sessionType:'real'})).toBeNull();
    expect(chartEntryError({...option,right:undefined},{...session,sessionType:'real'})).toMatch(/exact CE\/PE/);
  });
  it('isolates price picks and bulk edits by right, strike and expiry',()=>{
    expect(matchesChartContract(option,option)).toBe(true);
    for(const other of [{...option,right:'PE'},{...option,strike:24100},{...option,expiry:'2026-10-27'},{right:null}])expect(matchesChartContract(other,option)).toBe(false);
    expect(matchesChartContract(option,{type:'equity'})).toBe(false);
  });
  it('does not substitute an underlying quote for an unavailable option quote',()=>{
    expect(()=>chartMarketPrice('CE',{equity:24000,ce:0,pe:90})).toThrow(/valid quote/);
    expect(chartMarketPrice('PE',{equity:24000,ce:80,pe:90})).toBe(90);
  });
  it('stops a sequential batch after a failure without replaying earlier writes',async()=>{
    const writes:number[]=[];
    await expect(runChartOrderBatch([1,2,3],async n=>{writes.push(n);if(n===2)throw new Error('Outcome unknown')})).rejects.toThrow(/1 of 3 orders updated/);
    expect(writes).toEqual([1,2]);
  });
  it.each(['CE','PE'])('preserves %s contract and protection through existing order API serialization',async right=>{
    vi.stubGlobal('localStorage',{getItem:()=>null});vi.stubGlobal('window',{dispatchEvent:vi.fn()});vi.stubGlobal('CustomEvent',class{constructor(public type:string){}});
    const fetcher=vi.fn(async(url:string)=>({ok:true,status:200,json:async()=>url.includes('/settings')?{target_deviation_pct:.01}:{order_id:'order'}}));vi.stubGlobal('fetch',fetcher);
    await api.placeOrder('replay','BUY','LIMIT',100,50,{right,strike:24000,expiry:'2026-10-20',entry_sl_price:90});
    const call=fetcher.mock.calls.find(c=>String(c[0]).endsWith('/api/orders')) as unknown as [string,{body:string}];
    expect(JSON.parse(call[1].body)).toMatchObject({session_id:'replay',right,strike:24000,expiry:'2026-10-20',entry_sl_price:90,limit_price:100});
  });
});
it('fills the KLine two-row/three-chart height while preserving Lightweight toolbar allowance',()=>{
  expect(chartPaneHeight(700,'kline',2)*2+4).toBe(700);
  expect(chartPaneHeight(700,'kline',1)).toBe(700);
  expect(chartPaneHeight(700,'lightweight',2)*2+4+64).toBe(700);
});
it('rejects malformed history without fabricating candles',()=>{
  expect(checkedChartCandles([])).toEqual([]);
  expect(()=>checkedChartCandles(null)).toThrow(/invalid candles/);
  expect(()=>checkedChartCandles([{time:1,open:null,high:2,low:1,close:2}])).toThrow(/invalid candles/);
});

import { buildDayChartContextMenu } from '../../frontend/src/services/dayChartContextMenu';
function menuFixture(right?: 'CE' | 'PE') {
  vi.stubGlobal('localStorage',{getItem:()=>null});
  const flat={side:'FLAT',quantity:0};
  const pane={id:1,type:right?'options':'equity',right,strike:right?24000:undefined,expiry:right?'2026-10-20':undefined};
  const environment={
    contextMenu:{sessionId:'session',paneId:1,price:100,x:30,y:40,paneType:pane.type,right,strike:pane.strike,expiry:pane.expiry},
    sim:{sessionId:'session',symbol:'NIFTY',sessionInstrumentType:'options',sessionType:'sim',sessionExpiry:'2026-10-20',sessionStrikeCE:24000,sessionStrikePE:24000,trades:[],openOrders:[],position:flat,positionCE:flat,positionPE:flat,updateOrder:vi.fn().mockResolvedValue({}),bulkUpdateOrders:vi.fn()},
    simRef:{current:{sessionId:'session'}},panes:[pane],sizingMode:'quantity',cancelPricePick:vi.fn(),setMissingSlPick:vi.fn(),setContextMenuEntryTicket:vi.fn(),setBrokerError:vi.fn(),strategySyncVersionRef:{current:0},setRunningStrategies:vi.fn(),setBrokerOrdersSnapshot:vi.fn(),targetDeviationPct:.01,
  };
  const build=()=>buildDayChartContextMenu(environment as unknown as Parameters<typeof buildDayChartContextMenu>[0]);
  return {environment,build};
}
it('underlying menu exposes no option-priced entries, bulk changes or premium strategies',()=>{
  const actions=menuFixture().build();
  expect(actions.some(a=>a.label.startsWith('Use as SL')||a.label==='Shift SL to here'||a.label==='Make as limit price')).toBe(false);
  expect(actions.find(a=>a.label.includes('CE/PE chart'))?.disabled).toBe(true);
});
it.each(['CE','PE'] as const)('production %s menu ticket keeps its session, pane and exact contract',right=>{
  const {environment,build}=menuFixture(right);build().find(a=>a.label.startsWith('Use as SL'))!.onClick!();
  expect(environment.setContextMenuEntryTicket).toHaveBeenCalledWith(expect.objectContaining({sessionId:'session',paneId:1,right,strike:24000,expiry:'2026-10-20',symbol:'NIFTY'}));
});
it('underlying strategies retain explicit CE contracts instead of premium strategies',async()=>{
  const {environment,build}=menuFixture();environment.sim.positionCE={side:'LONG',quantity:50};
  const start=vi.spyOn(api,'startStrategy').mockResolvedValue({strategy_id:'s'} as never);
  try {
    const strategies=build().find(a=>a.label==='Start strategy')!.submenu!;
    expect(strategies.map(a=>a.label)).toEqual(['Underlying Target (CE)','Underlying SL (CE)']);
    strategies[0].submenu![0].onClick!();
    await vi.waitFor(()=>expect(start).toHaveBeenCalledWith(expect.objectContaining({strategy_type:'UnderlyingTargetProfit',right:'CE',strike:24000,expiry:'2026-10-20'})));
  } finally { start.mockRestore(); }
});
it('production price-shift menu updates only the clicked option contract',async()=>{
  const {environment,build}=menuFixture('CE');
  const exact={side:'SELL',order_id:'exact',status:'PENDING',is_stoploss:true,order_type:'STOPLOSS',right:'CE',strike:24000,expiry:'2026-10-20'};
  environment.sim.trades=[{session_id:'session',right:'CE',strike:24000,expiry:'2026-10-20',side:'BUY',quantity:50}] as never;
  environment.sim.openOrders=[exact,{...exact,order_id:'other-strike',strike:24100},{...exact,order_id:'other-expiry',expiry:'2026-10-27'},{...exact,order_id:'other-right',right:'PE'}] as never;
  build().find(a=>a.label==='Shift SL to here')!.onClick!();
  await vi.waitFor(()=>expect(environment.sim.updateOrder).toHaveBeenCalledTimes(1));
  expect(environment.sim.updateOrder).toHaveBeenCalledWith('exact',100,undefined,.01);
});
it('a stale-session context cannot submit a menu action',()=>{
  const {environment,build}=menuFixture('CE');environment.contextMenu.sessionId='old-session';expect(build()).toEqual([]);
});

it('menu closes instead of reusing an old price after the chart contract changes',()=>{
  const {environment,build}=menuFixture('CE');environment.panes[0].strike=24100;expect(build()).toEqual([]);
});

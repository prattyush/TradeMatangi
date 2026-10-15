import { afterEach, describe, expect, it, vi } from 'vitest'
import api from '../../frontend/src/services/api'
import { activeSessionSubscriptions } from '../../frontend/src/services/sessionSubscriptions'
import type { SessionGroupResponse } from '../../frontend/src/services/api'

afterEach(() => vi.unstubAllGlobals())

describe('website replay connection', () => {
  it('keeps SSE URL construction synchronous through the notification facade', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ userId: 'replay-user' }) })
    const url = api.getSSEUrl('nifty-replay', '42')
    expect(typeof url).toBe('string')
    expect(url).toContain('/api/stream/nifty-replay')
    expect(url).toContain('user_id=replay-user')
    expect(url).toContain('last_event_id=42')
  })
  it('preserves asynchronous requests and their return values', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ balance: 1000 }) }))
    const response = api.getWallet('2026-10-07')
    expect(response).toBeInstanceOf(Promise)
    expect(await response).toEqual({ balance: 1000 })
  })
  it('sends Target % market sizing with its separate target and protective stop, without another sizing method', async () => {
    vi.stubGlobal('localStorage', {getItem:()=>null})
    vi.stubGlobal('window',{dispatchEvent:vi.fn()})
    vi.stubGlobal('CustomEvent',class {constructor(public type:string,public options:unknown){}})
    const fetcher=vi.fn().mockImplementation(async (url:string) => ({ok:true,status:200,json:async()=>url.includes('/settings')?{target_deviation_pct:.01}:{order_id:'target-entry'}}))
    vi.stubGlobal('fetch',fetcher)
    await api.placeOrder('session','BUY','LIMIT',110,null,{market_order:true,target_profit_pct:2,sizing_target_price:110,entry_sl_price:90,group_id:'group'})
    const call=fetcher.mock.calls.find(([url])=>String(url).endsWith('/api/orders'))!
    const body=JSON.parse(call[1].body)
    expect(body).toMatchObject({session_id:'session',market_order:true,order_type:'LIMIT',target_profit_pct:2,sizing_target_price:110,entry_sl_price:90,group_id:'group'})
    expect(body.quantity).toBeUndefined()
    expect(body.risk_pct).toBeUndefined()
    expect(body.funds_ratio_pct).toBeUndefined()
  })
  it('subscribes to a selected replay with no group, an empty group or stale ended members', () => {
    const empty = { members: [] } as unknown as SessionGroupResponse
    const ended = { members: [{ session_id: 'old', state: 'ended' }] } as SessionGroupResponse
    for (const group of [null, empty, ended]) expect(activeSessionSubscriptions(group, 'new', 'running')).toEqual(['new'])
  })
  it('deduplicates live group members and omits ended selections', () => {
    const group = { members: [{ session_id: 'a', state: 'running' }, { session_id: 'b', state: 'paused' }, { session_id: 'old', state: 'ended' }] } as SessionGroupResponse
    expect(activeSessionSubscriptions(group, 'b', 'running')).toEqual(['a', 'b'])
    expect(activeSessionSubscriptions(group, 'old', 'ended')).toEqual(['a', 'b'])
    expect(activeSessionSubscriptions(null, null, 'idle')).toEqual([])
  })
})

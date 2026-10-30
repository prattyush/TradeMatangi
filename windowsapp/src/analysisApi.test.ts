import { describe, it, expect, vi } from 'vitest'
import { analysisRequest, createAnalysisApi, validAnalysisPath, type AnalysisRequest } from './analysisApi'
import type { SessionDetail } from '../../shared/analysis/api'

const detail = { cycles: [] } as unknown as SessionDetail

describe('desktop analysis transport', () => {
  it('restricts reads and writes to the analysis allowlist', () => {
    for (const path of ['../orders', '/sessions', 'data/%2e%2e/orders', 'sessions#other', 'orders']) expect(validAnalysisPath(path, 'GET')).toBe(false)
    expect(validAnalysisPath('labels', 'POST')).toBe(true)
    expect(validAnalysisPath('sessions', 'POST')).toBe(false)
    for (const path of ['pattern/strategies', 'pattern/categories?']) expect(validAnalysisPath(path, 'POST')).toBe(true)
    for (const path of ['pattern/chart', 'pattern/ohlc/equity', 'pattern/strategies/extra']) expect(validAnalysisPath(path, 'POST')).toBe(false)
    expect(validAnalysisPath('snapshots?session_id=owned', 'DELETE')).toBe(true)
  })
  it('registers a new category or strategy through the allowlisted POST routes', async () => {
    const request = vi.fn().mockResolvedValue({ categories: ['Trend'] }) as unknown as AnalysisRequest
    const adapter = createAnalysisApi(request)
    await expect(adapter.api.patternAddCategory('Trend')).resolves.toEqual({ categories: ['Trend'] })
    await adapter.api.patternAddStrategy('ORB')
    expect(request).toHaveBeenNthCalledWith(1, 'pattern/categories?', 'POST', { name: 'Trend' }, expect.anything())
    expect(request).toHaveBeenNthCalledWith(2, 'pattern/strategies?', 'POST', { name: 'ORB' }, expect.anything())
  })
  it('fences a late native response after cancellation', async () => {
    let resolve!: (value: unknown) => void
    const native = (() => new Promise(r => { resolve = r })) as AnalysisRequest
    const controller = new AbortController()
    const result = analysisRequest('http://localhost', '', native)('sessions', 'GET', undefined, controller.signal)
    controller.abort(); resolve([])
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('does not let old account requests resolve successfully', async () => {
    let resolve!: (value: unknown) => void
    let signal: AbortSignal | undefined
    const request = ((_path, _method, _body, currentSignal) => { signal = currentSignal; return new Promise(r => { resolve = r }) }) as AnalysisRequest
    const adapter = createAnalysisApi(request)
    const result = adapter.api.getSessionDetail('session')
    adapter.dispose()
    expect(signal?.aborted).toBe(true)
    resolve(detail)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(adapter.api.getLabels('session')).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('memoizes detail and retries a failed read', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(detail) as unknown as AnalysisRequest
    const adapter = createAnalysisApi(request)
    await expect(adapter.api.getSessionDetail('session')).rejects.toThrow('offline')
    await adapter.api.getSessionDetail('session')
    await adapter.api.getSessionDetail('session')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('uses exact website history parameter names and units', async () => {
    const request = vi.fn().mockResolvedValue({ candles: [] }) as unknown as AnalysisRequest
    const adapter = createAnalysisApi(request)
    await adapter.api.getOptionsHistorical('NIFTY', '2026-10-06', 25000, '2026-10-08', 'CE', 3, 2)
    const path = (request as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    const query = new URLSearchParams(path.split('?')[1])
    expect(query.get('date')).toBe('2026-10-06')
    expect(query.get('expiry')).toBe('2026-10-08')
    expect(query.get('strike')).toBe('25000')
    expect(query.get('interval_minutes')).toBe('3')
  })
})

it('rejects an aborted native call promptly and fences a late unauthorized response', async () => {
  let reject!: (reason:unknown)=>void
  const native=(()=>new Promise((_resolve,fail)=>{reject=fail})) as AnalysisRequest
  const unauthorized=vi.fn(),controller=new AbortController()
  const result=analysisRequest('http://localhost','',native,unauthorized)('sessions','GET',undefined,controller.signal)
  controller.abort()
  await expect(result).rejects.toMatchObject({name:'AbortError'})
  reject(new Error('Analysis request failed (401): expired'))
  await Promise.resolve()
  expect(unauthorized).not.toHaveBeenCalled()
})
it('reports active native authentication expiry',async()=>{
  const unauthorized=vi.fn()
  const native=vi.fn().mockRejectedValue(new Error('Analysis request failed (401): expired')) as unknown as AnalysisRequest
  await expect(analysisRequest('http://localhost','',native,unauthorized)('sessions','GET')).rejects.toThrow('401')
  expect(unauthorized).toHaveBeenCalledTimes(1)
})


describe('Real analytics fee metadata routes', () => {
  it('permits only the exact correction endpoint and scopes its transport', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) expect(validAnalysisPath('performance/real-fees?date=2026-10-09', method)).toBe(true)
    expect(validAnalysisPath('performance/real-fees/orders', 'POST')).toBe(false)
    expect(validAnalysisPath('performance/cycles', 'POST')).toBe(false)
    const request = vi.fn().mockResolvedValue({date:'2026-10-09',accounts:[]}) as unknown as AnalysisRequest
    const adapter = createAnalysisApi(request)
    await adapter.performance.saveRealFees!('2026-10-09','account',12.34)
    expect(request).toHaveBeenCalledWith('performance/real-fees','POST',{date:'2026-10-09',account_id:'account',actual_total:12.34},expect.any(AbortSignal))
  })
})


describe('snapshot candle transport', () => {
  it('allows only the exact read route and carries event, session and contract side', async () => {
    expect(validAnalysisPath('snapshots/event-one/candle?session_id=s&instrument=CE','GET')).toBe(true)
    for(const method of ['POST','DELETE','PUT'])expect(validAnalysisPath('snapshots/event-one/candle',method)).toBe(false)
    for(const path of ['snapshots/event-one','snapshots/../candle','snapshots/event-one/candle/extra'])expect(validAnalysisPath(path,'GET')).toBe(false)
    const request=vi.fn().mockResolvedValue({candle:null}) as unknown as AnalysisRequest
    const adapter=createAnalysisApi(request)
    await adapter.api.getSnapshotCandle!('session-one','event-one','PE')
    expect(request).toHaveBeenCalledWith('snapshots/event-one/candle?session_id=session-one&instrument=PE','GET',undefined,expect.any(AbortSignal))
  })
  it('rejects an event candle reply after an account change', async () => {
    let resolve!:(value:unknown)=>void
    const request=(()=>new Promise(r=>{resolve=r})) as AnalysisRequest
    const adapter=createAnalysisApi(request)
    const pending=adapter.api.getSnapshotCandle!('s','e','underlying')
    adapter.dispose();resolve({candle:null})
    await expect(pending).rejects.toMatchObject({name:'AbortError'})
  })
})

it('sends broker scope for Day charges without changing legacy requests', async () => {
  const request = vi.fn().mockResolvedValue({date:'2026-10-09',accounts:[]}) as unknown as AnalysisRequest
  const adapter = createAnalysisApi(request)
  await adapter.performance.saveRealFees!('2026-10-09','shared-id',12,'kite')
  expect(request).toHaveBeenCalledWith('performance/real-fees','POST',{date:'2026-10-09',account_id:'shared-id',actual_total:12,execution_broker:'kite'},expect.any(AbortSignal))
  await adapter.performance.deleteRealFees!('2026-10-09','shared-id','kite')
  expect(request).toHaveBeenCalledWith('performance/real-fees?date=2026-10-09&account_id=shared-id&execution_broker=kite','DELETE',undefined,expect.any(AbortSignal))
})

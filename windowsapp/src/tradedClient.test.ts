import { describe, expect, it, vi } from 'vitest'
import { createTradedClient } from '../../shared/traded/client'
import { createPatternsClient } from './patternsClient'
import { patternsRequest, validPatternsPath } from './patternsApi'

describe('traded patterns client', () => {
  const ref = { category: 'Breakout', strategy: 'Opening range' }

  it('builds the calls the server routes expect', async () => {
    const request = vi.fn(async () => ({ strategies: [{ strategy: 'x' }] }))
    const api = createTradedClient(request as never)
    expect(await api.summary()).toEqual([{ strategy: 'x' }])
    await api.summary({ start: '2026-10-01', end: '2026-10-31' })
    await api.list(ref)
    await api.list(ref, { start: '2026-10-01', limit: 25 })
    await api.save({ session_id: 's1', round_trip_index: 3 }, ref)
    expect(request.mock.calls).toEqual([
      ['pattern/traded/summary', 'GET'],
      ['pattern/traded/summary?start_date=2026-10-01&end_date=2026-10-31', 'GET'],
      ['pattern/traded?category=Breakout&strategy=Opening+range', 'GET'],
      ['pattern/traded?category=Breakout&strategy=Opening+range&start_date=2026-10-01&limit=25', 'GET'],
      ['pattern/traded/save', 'POST', { session_id: 's1', round_trip_index: 3, category: 'Breakout', strategy: 'Opening range' }],
    ])
  })

  it('every path it builds passes the desktop allowlist, and the desktop client uses the same paths', async () => {
    const seen: Array<[string, string]> = []
    const native = vi.fn(async (_command: string, args: Record<string, unknown>) => { seen.push([String(args.path), String(args.method)]); return { strategies: [] } })
    const traded = createPatternsClient(patternsRequest('http://x', native)).traded
    await traded.summary({ start: '2026-10-01' })
    await traded.list(ref, { end: '2026-10-31', limit: 10 })
    await traded.save({ session_id: 'abc-1', round_trip_index: 0 }, ref)
    expect(seen).toHaveLength(3)
    for (const [path, method] of seen) expect(validPatternsPath(path, method), `${method} ${path}`).toBe(true)
  })
})

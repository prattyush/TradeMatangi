import { describe, expect, it, vi } from 'vitest'
import { patternsRequest, validPatternsPath } from './patternsApi'

const OK: [string, string][] = [
  ['GET', 'pattern/strategies'], ['GET', 'pattern/charts?symbol=NIFTY'], ['GET', 'pattern/chart/by-date?date=2026-10-01'],
  ['GET', 'pattern/chart/abc-123'], ['POST', 'pattern/chart'], ['PUT', 'pattern/chart/abc_1'], ['DELETE', 'pattern/chart/abc'],
  ['POST', 'pattern/charts/bulk-delete'], ['GET', 'pattern/ohlc/options?symbol=NIFTY'],
  ['GET', 'chart-structures/types'], ['GET', 'chart-structures/ohlc/NIFTY/2026-10-01'], ['PUT', 'chart-structures/structure/s1'],
  ['GET', 'fine-structures/flows'], ['POST', 'fine-structures/search'], ['DELETE', 'fine-structures/definition/d1'],
  ['GET', 'fine-structures/ohlc-options/NIFTY/2026-10-01?right=CE'],
  ['GET', 'data/symbols'], ['GET', 'data/price-at?symbol=NIFTY'], ['GET', 'data/options/find-strike-by-price?symbol=NIFTY'],
  ['GET', 'pattern/traded?category=A&strategy=B'], ['GET', 'pattern/traded/summary'], ['POST', 'pattern/traded/save'],
  ['GET', 'deep-dive/dives'], ['GET', 'deep-dive/dive?category=A&strategy=B'], ['GET', 'deep-dive/stats?category=A'],
  ['GET', 'deep-dive/stats/all'], ['PUT', 'deep-dive/setup'], ['DELETE', 'deep-dive/setup?date=2026-10-01'],
  ['PUT', 'deep-dive/setup/tag-values'], ['POST', 'deep-dive/setup/save-to-patterns'], ['POST', 'deep-dive/tags'],
  ['POST', 'deep-dive/tags/abc123/update'], ['POST', 'deep-dive/tags/abc123/archive'], ['POST', 'deep-dive/tags/abc123/restore'],
  ['GET', 'deep-dive/practice/strategies'], ['GET', 'deep-dive/practice/runs'], ['GET', 'deep-dive/practice/evaluate?session_id=abc'], ['POST', 'deep-dive/practice/pick'],
]
const BAD: [string, string][] = [
  ['DELETE', 'pattern/strategies'], ['PUT', 'pattern/chart'], ['POST', 'pattern/chart/abc'], ['GET', 'pattern/chart/'],
  ['GET', 'pattern/chart/a/b'], ['GET', 'pattern/chart/a%2Fb'], ['GET', '../analysis/sessions'], ['GET', '/pattern/strategies'],
  ['GET', 'chart-structures/ohlc/NIFTY/2026-10-01/x'], ['GET', 'chart-structures/ohlc/NIFTY/not-a-date'],
  ['GET', 'data/historical'], ['POST', 'data/symbols'], ['GET', 'orders'], ['GET', 'trading/orders'],
  ['GET', 'pattern/chart/a\\b'], ['PATCH', 'pattern/chart/abc'], ['GET', ''],
  ['POST', 'pattern/traded'], ['PUT', 'pattern/traded/save'], ['DELETE', 'pattern/traded'], ['GET', 'pattern/traded/save'], ['GET', 'pattern/traded/summary/x'], ['POST', 'pattern/traded/summary'],
  ['POST', 'deep-dive/dives'], ['DELETE', 'deep-dive/dive'], ['PUT', 'deep-dive/tags'], ['GET', 'deep-dive/setup'],
  ['POST', 'deep-dive/setup'], ['GET', 'deep-dive/stats/all/x'], ['POST', 'deep-dive/tags/a/b/update'],
  ['POST', 'deep-dive/tags/abc/delete'], ['POST', 'deep-dive/tags//update'], ['GET', 'deep-dive/tags'],
  ['POST', 'deep-dive/practice/strategies'], ['POST', 'deep-dive/practice/runs'], ['POST', 'deep-dive/practice/evaluate'], ['GET', 'deep-dive/practice/pick'],
  ['PUT', 'deep-dive/practice/pick'], ['DELETE', 'deep-dive/practice/runs'], ['GET', 'deep-dive/practice'], ['GET', 'deep-dive/practice/evaluate/x'],
  ['GET', 'deep-dive/practice/strategies/x'], ['POST', 'deep-dive/practice/pick/x'],
]

describe('patterns allowlist (same cases as the Rust test)', () => {
  it.each(OK)('allows %s %s', (method, path) => expect(validPatternsPath(path, method)).toBe(true))
  it.each(BAD)('rejects %s %s', (method, path) => expect(validPatternsPath(path, method)).toBe(false))
})

describe('patternsRequest', () => {
  it('calls the native command with the path and method', async () => {
    const native = vi.fn().mockResolvedValue({ strategies: [] })
    const result = await patternsRequest('http://x', native)('pattern/strategies', 'GET')
    expect(result).toEqual({ strategies: [] })
    expect(native).toHaveBeenCalledWith('desktop_patterns_request', { baseUrl: 'http://x', path: 'pattern/strategies', method: 'GET', body: null })
  })
  it('never reaches native for a disallowed path', async () => {
    const native = vi.fn()
    await expect(patternsRequest('http://x', native)('orders', 'GET')).rejects.toThrow('Invalid patterns request')
    expect(native).not.toHaveBeenCalled()
  })
  it('rejects when already aborted', async () => {
    const native = vi.fn()
    const controller = new AbortController(); controller.abort()
    await expect(patternsRequest('http://x', native)('pattern/strategies', 'GET', null, controller.signal)).rejects.toThrow()
    expect(native).not.toHaveBeenCalled()
  })
})

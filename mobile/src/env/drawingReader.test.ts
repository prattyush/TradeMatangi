import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/transport'
import { createDrawingReader, createSymbolResolver } from './drawingReader'

const client = (answer: unknown = {}) => {
  const request = vi.fn(async () => answer)
  return { api: { request } as unknown as ApiClient, request }
}

describe('phone drawings reader', () => {
  it('reads a drawing list, the chart colours and the catalogue through the phone transport', async () => {
    const { api, request } = client({ drawings: [] })
    const read = createDrawingReader(api)
    await read(`drawings?instrument=${encodeURIComponent('{"kind":"index"}')}`, 'GET')
    await read('chart-settings', 'GET')
    await read('catalogue', 'GET')
    expect(request.mock.calls.map(c => (c as unknown[])[0])).toEqual([
      `/api/desktop/v1/drawings?instrument=${encodeURIComponent('{"kind":"index"}')}`, '/api/desktop/v1/chart-settings', '/api/desktop/v1/catalogue',
    ])
  })

  it('refuses every write and every other route before anything is sent', async () => {
    const { api, request } = client()
    const read = createDrawingReader(api)
    for (const [path, method] of [['drawings', 'POST'], ['drawings/abc', 'PUT'], ['drawings/abc', 'DELETE'], ['swing/portfolios/x', 'GET'], ['sessions', 'GET'], ['drawings?instrument=a&x=1', 'GET'], ['drawings/abc', 'GET']] as const) {
      await expect(read(path, method)).rejects.toThrow(/read-only/)
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('resolves a symbol to the catalogue kind and exchange, reading the catalogue once', async () => {
    const { api, request } = client({ instruments: [
      { symbol: 'NIFTY', exchange: 'NSE', chart_type: 'index' }, { symbol: 'BSESEN', exchange: 'BSE', chart_type: 'index' }, { symbol: 'TCS', exchange: 'NSE' },
    ] })
    const resolve = createSymbolResolver(createDrawingReader(api))
    expect(await resolve('NIFTY')).toEqual({ kind: 'index', exchange: 'NSE' })
    expect(await resolve('BSESEN')).toEqual({ kind: 'index', exchange: 'BSE' })
    expect(await resolve('TCS')).toEqual({ kind: 'equity', exchange: 'NSE' }) // no chart type: equity
    expect(await resolve('NOPE')).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('tries the catalogue again after a failure', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ instruments: [{ symbol: 'NIFTY', exchange: 'NSE', chart_type: 'index' }] })
    const resolve = createSymbolResolver(createDrawingReader({ request } as unknown as ApiClient))
    await expect(resolve('NIFTY')).rejects.toThrow('offline')
    expect(await resolve('NIFTY')).toEqual({ kind: 'index', exchange: 'NSE' })
  })
})

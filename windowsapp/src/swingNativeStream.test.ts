import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), receive: null as null | ((event: { payload: { key: string } }) => void) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
import { nativeSwingSubscribe } from './swingStream'
beforeEach(() => { vi.clearAllMocks(); mocks.listen.mockImplementation(async (_name, receive) => { mocks.receive = receive; return mocks.unlisten }) })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
describe('native Swing SSE', () => {
  it('uses owned native streams and event-driven IPC; delivers batches and gap recovery', async () => {
    const delivered: unknown[] = [], errors: unknown[] = []
    let payload = { latest_payload: { type: 'portfolio_snapshot', pnl: 10 }, events_dropped: false }
    mocks.invoke.mockImplementation(async name => name === 'desktop_stream_snapshot' ? payload : undefined)
    const stop = nativeSwingSubscribe('http://server', 'screen-one')('portfolio/events', e => delivered.push(e), e => errors.push(e))
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('start_desktop_stream', { baseUrl: 'http://server', key: 'swing:screen-one:portfolio/events', eventsPath: 'swing/portfolios/portfolio/events', snapshotPath: 'swing/portfolios/portfolio' })
    expect(delivered).toEqual([{ type: 'portfolio_snapshot', pnl: 10 }])
    payload = { latest_payload: { type: 'batch', events: [{ type: 'portfolio_snapshot', pnl: 12 }] } as any, events_dropped: true }
    mocks.receive!({ payload: { key: 'swing:other:portfolio/events' } })
    await flush()
    expect(delivered).toHaveLength(1)
    mocks.receive!({ payload: { key: 'swing:screen-one:portfolio/events' } })
    await flush()
    expect(delivered.slice(1)).toEqual([{ type: 'portfolio_refresh_required' }, { type: 'portfolio_snapshot', pnl: 12 }])
    stop(); await flush()
    expect(mocks.unlisten).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledWith('stop_desktop_stream', { key: 'swing:screen-one:portfolio/events' })
    expect(errors).toEqual([])
  })
  it('unmount during async listener startup cannot leave a native stream running', async () => {
    let resolve!: (value: () => void) => void
    mocks.listen.mockImplementation(() => new Promise(r => { resolve = r }))
    const stop = nativeSwingSubscribe('http://server', 'screen-two')('portfolio/events', () => undefined, () => undefined)
    await flush(); stop(); resolve(mocks.unlisten); await flush()
    expect(mocks.invoke.mock.calls.some(([name]) => name === 'start_desktop_stream')).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledWith('stop_desktop_stream', { key: 'swing:screen-two:portfolio/events' })
  })
})

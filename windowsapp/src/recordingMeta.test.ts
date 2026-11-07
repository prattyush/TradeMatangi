import { describe, expect, it } from 'vitest'
import { MAX_RECORDING_SAMPLES, RecordingMetaRecorder, metaFileName, type RecordingClockSession } from '../../shared/recordingMeta'
import { desktopRecordingSessions, websiteRecordingSessions } from '../../shared/recordingClocks'

function clockOf(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
const session = (marketTime: number | null, extra: Partial<RecordingClockSession> = {}): RecordingClockSession => ({
  sessionId: 's1', sessionType: 'sim', symbol: 'NIFTY', date: '2026-11-06', marketTime, ...extra,
})

describe('RecordingMetaRecorder', () => {
  it('names the file beside the video', () => {
    expect(metaFileName('TradeMatangi_NIFTY_2026-11-06_sim.webm')).toBe('TradeMatangi_NIFTY_2026-11-06_sim.rec.json')
    expect(metaFileName('clip.WEBM')).toBe('clip.rec.json')
  })

  it('records start, stop and the video length', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start(); c.advance(60_000); r.stop()
    const meta = r.toJSON()
    expect(meta.wallStartMs).toBe(1_000_000)
    expect(meta.wallStopMs).toBe(1_060_000)
    expect(meta.videoDurationMs).toBe(60_000)
    expect(meta.events.map(e => e.t)).toEqual(['start', 'stop'])
    expect(meta.source).toBe('website')
    expect(meta.videoFile).toBe('a.webm')
  })

  it('removes paused time from the video length, across several pauses', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'desktop', videoFile: 'a.webm' })
    r.start(); c.advance(10_000)
    r.pause(); c.advance(5_000); r.resume()
    c.advance(10_000)
    r.pause(); c.advance(20_000); r.resume()
    c.advance(5_000); r.stop()
    expect(r.toJSON().videoDurationMs).toBe(25_000)
    expect(r.toJSON().events.map(e => e.t)).toEqual(['start', 'pause', 'resume', 'pause', 'resume', 'stop'])
  })

  it('closes a pause when stopped while paused', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start(); c.advance(10_000); r.pause(); c.advance(30_000); r.stop()
    const meta = r.toJSON()
    expect(meta.videoDurationMs).toBe(10_000)
    expect(meta.events.map(e => e.t)).toEqual(['start', 'pause', 'resume', 'stop'])
  })

  it('ignores repeated or out-of-order calls', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.pause(); r.resume(); r.stop()
    expect(r.toJSON().events).toEqual([])
    r.start(); r.start(); r.resume(); r.pause(); r.pause(); c.advance(1000); r.resume(); r.resume(); r.stop(); r.stop(); r.pause()
    expect(r.toJSON().events.map(e => e.t)).toEqual(['start', 'pause', 'resume', 'stop'])
  })

  it('samples sessions once per call and keeps sampling while the recording is paused', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start()
    r.sample(() => [session(100)]); c.advance(1000)
    r.pause()
    r.sample(() => [session(101)]); c.advance(1000)
    r.resume()
    r.sample(() => [session(102)])
    expect(r.toJSON().samples).toEqual([
      { wallMs: 1_000_000, sessionId: 's1', marketTime: 100 },
      { wallMs: 1_001_000, sessionId: 's1', marketTime: 101 },
      { wallMs: 1_002_000, sessionId: 's1', marketTime: 102 },
    ])
  })

  it('keeps repeated market times so a stepwise jump keeps its wall time', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start()
    for (const t of [100, 100, 100, 280]) { r.sample(() => [session(t)]); c.advance(1000) }
    expect(r.toJSON().samples.map(s => s.marketTime)).toEqual([100, 100, 100, 280])
  })

  it('records session details once and fills in details that arrive later', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start()
    r.sample(() => [session(null, { candleSeconds: 180 })])
    r.sample(() => [session(50, { replaySpeed: 0.5, stepwise: false })])
    const meta = r.toJSON()
    expect(meta.sessions).toEqual([{ sessionId: 's1', sessionType: 'sim', symbol: 'NIFTY', date: '2026-11-06', candleSeconds: 180, replaySpeed: 0.5, stepwise: false }])
    expect(meta.samples).toHaveLength(1)
  })

  it('tracks several sessions and a session that starts mid-recording', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'desktop', videoFile: 'a.webm' })
    r.start()
    r.sample(() => []); c.advance(1000)
    r.sample(() => [session(10, { sessionId: 'a' }), session(20, { sessionId: 'b' })])
    expect(r.toJSON().sessions.map(s => s.sessionId)).toEqual(['a', 'b'])
    expect(r.toJSON().samples).toHaveLength(2)
  })

  it('never throws when the clock fails or returns junk', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start()
    expect(() => r.sample(() => { throw new Error('boom') })).not.toThrow()
    expect(() => r.sample(() => null as unknown as RecordingClockSession[])).not.toThrow()
    expect(() => r.sample(() => [null, { sessionId: '' }, session(Number.NaN), session(Infinity)] as unknown as RecordingClockSession[])).not.toThrow()
    expect(() => r.sample(undefined)).not.toThrow()
    expect(r.toJSON().samples).toEqual([])
  })

  it('does not sample before start or after stop', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.sample(() => [session(1)])
    r.start(); r.stop()
    r.sample(() => [session(2)])
    expect(r.toJSON().samples).toEqual([])
  })

  it('caps the sample count on very long recordings and keeps the newest sample', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start()
    for (let i = 0; i < MAX_RECORDING_SAMPLES + 5; i++) { r.sample(() => [session(i + 1)]); c.advance(1000) }
    const samples = r.toJSON().samples
    expect(samples.length).toBeLessThanOrEqual(MAX_RECORDING_SAMPLES)
    expect(samples[samples.length - 1].marketTime).toBe(MAX_RECORDING_SAMPLES + 5)
  })

  it('serialises to JSON and back unchanged', () => {
    const c = clockOf()
    const r = new RecordingMetaRecorder({ now: c.now, source: 'website', videoFile: 'a.webm' })
    r.start(); r.sample(() => [session(5)]); c.advance(2000); r.stop()
    const meta = r.toJSON()
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
    expect(meta.version).toBe(1)
  })
})

describe('website clock', () => {
  const base = { sessionId: 's1', sessionState: 'running', sessionType: 'sim', symbol: 'NIFTY', date: '2026-11-06' }
  it('uses the newest tick time among equity, CE and PE', () => {
    const [s] = websiteRecordingSessions({ ...base, tickTimes: [1000, 1180, null], candleSeconds: 180, speed: 0.5, stepwise: false })
    expect(s).toMatchObject({ sessionId: 's1', marketTime: 1180, candleSeconds: 180, replaySpeed: 0.5, stepwise: false })
  })
  it('reports no time before the first tick or after the session ended', () => {
    expect(websiteRecordingSessions({ ...base, tickTimes: [null, undefined] })[0].marketTime).toBeNull()
    expect(websiteRecordingSessions({ ...base, sessionState: 'ended', tickTimes: [1000] })[0].marketTime).toBeNull()
  })
  it('reports nothing without a session', () => {
    expect(websiteRecordingSessions({ ...base, sessionId: null, tickTimes: [1000] })).toEqual([])
  })
})

describe('desktop clock', () => {
  const session1 = { session_id: 'd1', symbol: 'NIFTY', date: '2026-11-06', state: 'running', speed: 1 }
  const nowMs = Date.UTC(2026, 10, 6, 4, 0, 0) // 09:30 IST
  it('uses the wall clock plus the IST offset for paper and real', () => {
    for (const mode of ['Paper', 'Real']) {
      const [s] = desktopRecordingSessions({ session: session1, mode, nowMs, replayCursor: 5, candleSeconds: 180 })
      expect(s.marketTime).toBe(Math.floor(nowMs / 1000) + 19_800)
      expect(s.sessionType).toBe(mode.toLowerCase())
    }
  })
  it('uses the replay cursor, then the session time, for replay and stepwise', () => {
    expect(desktopRecordingSessions({ session: session1, mode: 'Replay', nowMs, replayCursor: 777, sessionTime: 500 })[0].marketTime).toBe(777)
    expect(desktopRecordingSessions({ session: session1, mode: 'Replay', nowMs, replayCursor: null, sessionTime: 500 })[0].marketTime).toBe(500)
    const [step] = desktopRecordingSessions({ session: session1, mode: 'Stepwise', nowMs, replayCursor: 900 })
    expect(step).toMatchObject({ sessionType: 'stepwise', stepwise: true, marketTime: 900 })
  })
  it('reports nothing without a session, and no time once ended', () => {
    expect(desktopRecordingSessions({ session: null, mode: 'Paper', nowMs })).toEqual([])
    expect(desktopRecordingSessions({ session: { ...session1, state: 'ended' }, mode: 'Paper', nowMs })[0].marketTime).toBeNull()
  })
})

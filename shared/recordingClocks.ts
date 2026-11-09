import type { RecordingClockSession } from './recordingMeta'

/** IST is UTC+5:30; market timestamps are Unix seconds with the IST wall clock encoded as UTC. */
export const IST_OFFSET_SECONDS = 19_800

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** Session reported by the website for the recorder's once-a-second sample. */
export function websiteRecordingSessions(input: {
  sessionId: string | null
  sessionState: string
  sessionType: string
  symbol: string
  date: string
  /** Times of the latest equity / CE / PE ticks (IST-as-UTC seconds). */
  tickTimes: Array<number | null | undefined>
  candleSeconds?: number
  speed?: number | null
  stepwise?: boolean
}): RecordingClockSession[] {
  if (!input.sessionId) return []
  const ticks = input.tickTimes.filter(finite)
  const live = input.sessionState !== 'ended' && ticks.length > 0
  return [{
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    symbol: input.symbol,
    date: input.date,
    marketTime: live ? Math.max(...ticks) : null,
    candleSeconds: finite(input.candleSeconds) ? input.candleSeconds : undefined,
    replaySpeed: finite(input.speed) ? input.speed : undefined,
    stepwise: input.stepwise,
    ended: input.sessionState === 'ended',
  }]
}

/** Session reported by the desktop screen being recorded. */
export function desktopRecordingSessions(input: {
  session: { session_id: string; symbol: string; date: string; state?: string | null; speed?: number } | null | undefined
  /** 'Replay' | 'Stepwise' | 'Paper' | 'Real' | 'Browse' */
  mode: string
  /** Replay cursor while a replay/stepwise run is active (IST-as-UTC seconds). */
  replayCursor?: number | null
  /** Session's own clock, used when no replay run is active. */
  sessionTime?: number | null
  nowMs: number
  candleSeconds?: number
}): RecordingClockSession[] {
  const s = input.session
  if (!s?.session_id) return []
  const liveMode = input.mode === 'Paper' || input.mode === 'Real'
  const ended = s.state === 'ended'
  let marketTime: number | null = null
  if (!ended) {
    if (liveMode) marketTime = Math.floor(input.nowMs / 1000) + IST_OFFSET_SECONDS
    else if (finite(input.replayCursor)) marketTime = input.replayCursor
    else if (finite(input.sessionTime)) marketTime = input.sessionTime
  }
  return [{
    sessionId: s.session_id,
    sessionType: input.mode === 'Real' ? 'real' : input.mode === 'Paper' ? 'paper' : input.mode === 'Stepwise' ? 'stepwise' : 'sim',
    symbol: s.symbol,
    date: s.date,
    marketTime,
    candleSeconds: finite(input.candleSeconds) ? input.candleSeconds : undefined,
    replaySpeed: finite(s.speed) ? s.speed : undefined,
    stepwise: input.mode === 'Stepwise' ? true : undefined,
    ended,
  }]
}

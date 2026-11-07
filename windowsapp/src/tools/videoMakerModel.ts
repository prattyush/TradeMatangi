import type { RecordingMeta, RecordingSessionInfo } from '../../../shared/recordingMeta'
import { buildChapters, type ChapterList } from './chapters'
import { buildCutPlan, type CutPlan, type PlanTrade, type PlannedTrade } from './cutPlan'
import { buildPlanTrades, type RoundTripLike } from './tradeWindows'

/** Pure view-model helpers for the Trading Video Maker screen. */

export function parseRecordingMeta(text: string): { meta: RecordingMeta | null; error: string } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { meta: null, error: 'That file is not valid JSON.' } }
  const m = raw as Partial<RecordingMeta> | null
  if (!m || typeof m !== 'object') return { meta: null, error: 'That file is not recording metadata.' }
  if (m.version !== 1) return { meta: null, error: `Unsupported recording metadata version (${String(m.version)}).` }
  if (!Number.isFinite(m.wallStartMs) || !Array.isArray(m.events) || !Array.isArray(m.samples) || !Array.isArray(m.sessions)) {
    return { meta: null, error: 'The recording metadata is incomplete.' }
  }
  if (m.sessions.length === 0 || m.samples.length === 0) {
    return { meta: null, error: 'No trading session was on screen while this was recorded, so there is nothing to cut.' }
  }
  return {
    meta: {
      version: 1,
      source: m.source === 'desktop' ? 'desktop' : 'website',
      videoFile: String(m.videoFile ?? ''),
      wallStartMs: m.wallStartMs as number,
      wallStopMs: Number.isFinite(m.wallStopMs) ? (m.wallStopMs as number) : null,
      videoDurationMs: Number.isFinite(m.videoDurationMs) ? (m.videoDurationMs as number) : null,
      events: m.events, sessions: m.sessions, samples: m.samples,
    },
    error: '',
  }
}

export function sessionTypeLabel(type: string): string {
  switch (type) {
    case 'sim': return 'Replay'
    case 'stepwise': return 'Stepwise'
    case 'paper': return 'Paper'
    case 'real': return 'Real'
    default: return type
  }
}

export function describeSession(s: RecordingSessionInfo): string {
  return `${s.symbol} · ${s.date} · ${sessionTypeLabel(s.sessionType)}`
}

export const CANDLE_CHOICES = [60, 120, 180, 300, 600, 900]

/** Candle interval for the lead/lag bars: what the recorder saw, else 3 minutes. */
export function defaultCandleSeconds(meta: RecordingMeta, selectedIds: string[]): number {
  for (const s of meta.sessions) {
    if (selectedIds.includes(s.sessionId) && s.candleSeconds && s.candleSeconds > 0) return s.candleSeconds
  }
  return 180
}

/** Warns when the picked video does not look like the one the metadata describes. */
export function pairingWarning(meta: RecordingMeta, videoPath: string): string {
  const name = videoPath.split(/[\\/]/).pop() ?? ''
  if (meta.videoFile && name && meta.videoFile !== name) {
    return `This metadata was saved for "${meta.videoFile}", but the video is "${name}". If the browser renamed one of them, that is fine; otherwise pick the matching files.`
  }
  return ''
}

export interface PlanInput {
  meta: RecordingMeta
  selectedSessionIds: string[]
  tripsBySession: Record<string, RoundTripLike[]>
  candleSeconds: number
  nudgeSec: number
}

export interface VideoPlan {
  trades: PlanTrade[]
  plan: CutPlan
  chapters: ChapterList
}

export function computeVideoPlan(input: PlanInput): VideoPlan {
  const sessions = input.selectedSessionIds.map(sessionId => ({ sessionId, roundTrips: input.tripsBySession[sessionId] ?? [] }))
  const trades = buildPlanTrades(sessions)
  const plan = buildCutPlan({ meta: input.meta, trades, candleSeconds: input.candleSeconds, nudgeSec: input.nudgeSec })
  return { trades, plan, chapters: buildChapters(plan) }
}

/** HH:MM:SS of a market timestamp (IST-as-UTC seconds). */
export function marketClock(sec: number | null): string {
  return sec === null ? '—' : new Date(sec * 1000).toISOString().slice(11, 19)
}

export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function statusLabel(t: PlannedTrade): string {
  if (t.status === 'in-video') return 'In video'
  if (t.status === 'outside') return 'Not in this video'
  return 'No clock data'
}

export function suggestedOutputName(videoPath: string, mode: 'cut' | 'convert'): string {
  const file = videoPath.split(/[\\/]/).pop() ?? 'recording.webm'
  const stem = file.replace(/\.[^.]+$/, '')
  return `${stem}${mode === 'cut' ? '_trades' : ''}.mp4`
}

export function descriptionPathFor(mp4Path: string): string {
  return mp4Path.replace(/\.mp4$/i, '') + '_description.txt'
}

export interface JobRequestInput {
  input: string
  output: string
  mode: 'cut' | 'convert'
  plan: CutPlan | null
  totalSec: number
  crf?: number
  preferHardware?: boolean
}

/** Shape expected by the `video_job_start` command. */
export function buildJobRequest(i: JobRequestInput) {
  return {
    input: i.input,
    output: i.output,
    windows: i.mode === 'cut' && i.plan ? i.plan.windows.map(w => ({ startSec: w.startSec, endSec: w.endSec })) : [],
    totalSec: i.totalSec,
    crf: i.crf ?? 23,
    preferHardware: i.preferHardware ?? true,
  }
}

/** Why "Make video" is not available yet, or '' when it is. */
export function cannotStartReason(i: { ffmpegAvailable: boolean | null; hasMeta: boolean; mode: 'cut' | 'convert'; plan: CutPlan | null; output: string; running: boolean }): string {
  if (i.running) return 'A video is being made.'
  if (i.ffmpegAvailable === false) return 'ffmpeg was not found. Reinstall the app.'
  if (!i.output) return 'Choose where to save the video.'
  if (i.mode === 'cut') {
    if (!i.hasMeta) return 'Choose the recording and its .rec.json file first.'
    if (!i.plan || i.plan.windows.length === 0) return 'No trade falls inside this video, so there is nothing to cut.'
  }
  return ''
}

// --- Job events -----------------------------------------------------------------------------

export interface VideoEvent {
  jobId: string
  status: 'progress' | 'done' | 'error' | 'cancelled'
  percent: number
  message: string
  output?: string | null
  encoder?: string | null
  keptSec?: number | null
}

export interface JobUi {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  jobId: string | null
  percent: number
  message: string
  output: string | null
  encoder: string | null
  keptSec: number | null
}

export const IDLE_JOB: JobUi = { state: 'idle', jobId: null, percent: 0, message: '', output: null, encoder: null, keptSec: null }

export function startJob(jobId: string): JobUi {
  return { ...IDLE_JOB, state: 'running', jobId, message: 'Starting…' }
}

/** Applies a progress event; events for another job are ignored, and finished jobs stay finished. */
export function applyVideoEvent(ui: JobUi, e: VideoEvent): JobUi {
  if (ui.jobId !== null && e.jobId !== ui.jobId) return ui
  if (ui.state === 'done' || ui.state === 'error' || ui.state === 'cancelled') return ui
  switch (e.status) {
    case 'progress': return { ...ui, jobId: e.jobId, state: 'running', percent: Math.max(ui.percent, Math.min(99, e.percent)), message: e.message }
    case 'done': return { ...ui, jobId: e.jobId, state: 'done', percent: 100, message: e.message, output: e.output ?? null, encoder: e.encoder ?? null, keptSec: e.keptSec ?? null }
    case 'cancelled': return { ...ui, state: 'cancelled', message: 'Cancelled. Nothing was saved.' }
    case 'error': return { ...ui, state: 'error', message: e.message }
  }
}

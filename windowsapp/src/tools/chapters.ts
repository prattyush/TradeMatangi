import type { CutPlan } from './cutPlan'

/** YouTube chapter rules: first at 0:00, at least 3 chapters, each at least 10 seconds long. */
export const MIN_CHAPTERS = 3
export const MIN_CHAPTER_GAP_SEC = 10

export function formatTimestamp(sec: number, withHours: boolean): string {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return withHours ? `${h}:${pad(m)}:${pad(s)}` : `${m + h * 60}:${pad(s)}`
}

export function formatPnlPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'P&L n/a'
  const rounded = Math.round(pct * 100) / 100
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`
}

export interface Chapter { sec: number; title: string }

export interface ChapterList {
  chapters: Chapter[]
  /** Ready to paste into the YouTube description. */
  text: string
  warnings: string[]
}

export interface ChapterOptions {
  /** How far ahead of the entry the chapter points, in seconds of the finished video. */
  leadSec?: number
  introTitle?: string
}

/** Chapter list for a finished (cut) video. Only trades that are in the video get a chapter. */
export function buildChapters(plan: CutPlan, opts: ChapterOptions = {}): ChapterList {
  const leadSec = opts.leadSec ?? 10
  const chapters: Chapter[] = [{ sec: 0, title: opts.introTitle ?? 'Introduction' }]
  const shown = plan.trades
    .filter(t => t.status === 'in-video' && t.outputEntrySec !== null)
    .sort((a, b) => (a.outputEntrySec as number) - (b.outputEntrySec as number) || a.number - b.number)
  for (const t of shown) {
    const open = t.exitTime === null ? ' (open)' : ''
    // Point a little before the entry, but never before the start of the video.
    chapters.push({
      sec: Math.max(0, (t.outputEntrySec as number) - leadSec),
      title: `Trade ${t.number} · ${t.label} · ${formatPnlPct(t.pnlPct)}${open}`,
    })
  }

  const warnings: string[] = []
  if (shown.length === 0) warnings.push('No trade falls inside this video, so there are no trade chapters.')
  if (chapters.length < MIN_CHAPTERS) warnings.push(`YouTube shows chapters only when there are at least ${MIN_CHAPTERS}; this list has ${chapters.length}.`)
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].sec - chapters[i - 1].sec < MIN_CHAPTER_GAP_SEC) {
      warnings.push(`Chapters "${chapters[i - 1].title}" and "${chapters[i].title}" are under ${MIN_CHAPTER_GAP_SEC}s apart; YouTube may ignore the list.`)
      break
    }
  }
  const last = chapters[chapters.length - 1].sec
  const withHours = Math.max(last, plan.keptDurationSec) >= 3600
  const text = chapters.map(c => `${formatTimestamp(c.sec, withHours)} ${c.title}`).join('\n')
  return { chapters, text, warnings }
}

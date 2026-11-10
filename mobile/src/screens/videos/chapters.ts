/** A chapter of a saved video: where it starts (seconds) and its title. */
export interface VideoChapter { sec: number; title: string }

const LINE = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—:·]?\s*(.*?)\s*$/

/**
 * The chapters in a saved chapter text: one `M:SS Title` or `H:MM:SS Title` per line, the way they are pasted into a
 * YouTube description. Lines that are not a timestamp are ignored; the result is in time order.
 */
export function parseChapters(text: string | null | undefined): VideoChapter[] {
  const chapters: VideoChapter[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = LINE.exec(line)
    if (!match) continue
    const hours = match[1] ? Number(match[1]) : 0
    const minutes = Number(match[2])
    const seconds = Number(match[3])
    if (seconds > 59 || (match[1] && minutes > 59)) continue
    chapters.push({ sec: hours * 3600 + minutes * 60 + seconds, title: match[4] || `Chapter ${chapters.length + 1}` })
  }
  return chapters.sort((a, b) => a.sec - b.sec)
}

/** `1:05` or `1:02:03`, for showing a chapter's start. */
export function clock(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * The player address for a video: the production embed (verified on a phone, docs/spec-phase24-android-plan.md) that
 * starts playing, at a chapter when `startSec` is given. Choosing a chapter reloads the player with a new start.
 */
export function playerUrl(embed: string, startSec = 0): string {
  const url = new URL(embed)
  url.searchParams.set('autoplay', '1')
  url.searchParams.set('playsinline', '1')
  if (startSec > 0) url.searchParams.set('start', String(Math.floor(startSec)))
  return url.toString()
}

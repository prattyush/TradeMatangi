import { useEffect, useMemo, useState } from 'react'
import { useAnalysisApi } from '../../../../shared/analysis/environment'
import { EMBED_NOTE, PRIVATE_EMBED_NOTE, embedUrl, type SavedVideo } from '../../../../shared/analysis/videoLinks'
import { useToast } from '../../shell/Toast'
import { dateParts } from '../sessions/format'
import { clock, parseChapters, playerUrl } from './chapters'
import { useWakeLock } from './useWakeLock'

const PRIVACY: Record<string, string> = { private: 'Private', unlisted: 'Unlisted', public: 'Public' }

/** "NIFTY · 9 Nov" for each session the video was saved under (looked up once; a session that cannot be read is skipped). */
function useLinkedSessions(sessionIds: string[]): string[] {
  const api = useAnalysisApi()
  const key = sessionIds.join('|')
  const [labels, setLabels] = useState<string[]>([])
  useEffect(() => {
    let live = true
    setLabels([])
    void Promise.allSettled(sessionIds.map(id => api.getSessionDetail(id))).then(results => {
      if (!live) return
      const seen = new Set<string>()
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const { symbol, date } = result.value
        const parts = dateParts(date)
        seen.add(`${symbol} · ${parts.day} ${parts.month}`)
      }
      setLabels([...seen])
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key])
  return labels
}

/**
 * One saved video: the player on the left (as large as the height allows), the details and chapters on the right.
 * The player loads only when Play is pressed (nothing is sent to YouTube before) and only for Unlisted and Public videos;
 * Private ones cannot be embedded, so Open in YouTube is the way to watch them.
 */
export function VideoPlayer({ video, onBack, onOpen }: { video: SavedVideo; onBack: () => void; onOpen: () => void }) {
  const toast = useToast()
  const embed = embedUrl(video.videoId)
  const embeddable = !!embed && video.privacy !== 'private'
  const [start, setStart] = useState<number | null>(null) // null: not playing yet
  const chapters = useMemo(() => parseChapters(video.chapters), [video.chapters])
  const sessions = useLinkedSessions(video.sessionIds)
  const playing = start !== null
  useWakeLock(playing)
  useEffect(() => { setStart(null) }, [video.videoId])

  async function copy() {
    try { await navigator.clipboard.writeText(video.url); toast('Link copied') } catch { toast('Could not copy the link') }
  }

  return (
    <div className="video-detail">
      <div className="video-stage">
        {embeddable && playing && (
          <iframe
            key={`${video.videoId}:${start}`}
            className="video-frame"
            title={video.title}
            src={playerUrl(embed!, start)}
            allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
        {embeddable && !playing && (
          <div className="video-frame video-poster">
            <button type="button" className="play-button" aria-label="Play here" onClick={() => setStart(0)}>▶</button>
            <span>{EMBED_NOTE}</span>
          </div>
        )}
        {!embeddable && (
          <div className="video-frame video-poster">
            <span>{embed ? PRIVATE_EMBED_NOTE : 'This saved link has no valid video id, so it cannot play here.'}</span>
            {embed && <button type="button" className="btn btn-primary" onClick={onOpen}>Open on YouTube</button>}
          </div>
        )}
      </div>
      <aside className="video-side" aria-label="Video details">
        <header className="video-side-head">
          <button type="button" className="btn" onClick={onBack}>← Videos</button>
          <button type="button" className="btn" onClick={onOpen} aria-label="Open on YouTube">YouTube</button>
          <button type="button" className="btn" onClick={() => void copy()} aria-label="Copy link">Copy</button>
        </header>
        <div className="video-side-body">
          <h3 className="video-title">{video.title}</h3>
          <p className="video-meta">
            <span className={`badge badge-${video.privacy}`}>{PRIVACY[video.privacy] ?? video.privacy}</span>
            {sessions.length > 0 && <span> {sessions.join(', ')}</span>}
          </p>
          {chapters.length > 0
            ? (
              <ol className="chapter-list" aria-label="Chapters">
                {chapters.map((chapter, index) => (
                  <li key={`${chapter.sec}:${index}`}>
                    <button type="button" disabled={!embeddable} onClick={() => setStart(chapter.sec)} aria-label={`${clock(chapter.sec)} ${chapter.title}`}>
                      <span className="chapter-time">{clock(chapter.sec)}</span>
                      <span className="chapter-title">{chapter.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )
            : <p className="muted">No chapters were saved with this video.</p>}
        </div>
      </aside>
    </div>
  )
}

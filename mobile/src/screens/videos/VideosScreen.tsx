import { useMemo, useState } from 'react'
import { groupSavedVideos, type SavedVideo } from '../../../../shared/analysis/videoLinks'
import { useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import { describeError, isNotAvailable } from '../../api/errors'
import { useBackHandler, useTabReselect } from '../../app/Nav'
import { useLoad } from '../../app/useLoad'
import { EmptyState, ErrorState, NotAvailable, Spinner } from '../../shell/States'
import { VideoPlayer } from './VideoPlayer'
import './videos.css'

const PRIVACY: Record<string, string> = { private: 'Private', unlisted: 'Unlisted', public: 'Public' }

/** "9 Nov 2026" for an upload time; empty when the server sent something unreadable. */
function uploadDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** What the screen was showing when the user left it, so coming back finds the same video. */
const remembered: { selected: string | null } = { selected: null }

/**
 * Videos: every video saved with your sessions, newest first. Choosing one hides the list so the player gets the
 * height and width; the "← Videos" button, tapping Videos again, or Back brings the list back.
 */
export function VideosScreen() {
  const source = useAnalysisEnvironment().videoLinks
  const [selected, setSelected] = useState<string | null>(() => remembered.selected)
  const updateSelected = (id: string | null) => { remembered.selected = id; setSelected(id) }

  const loaded = useLoad(async () => {
    if (!source?.listMine) throw Object.assign(new Error('Not Found'), { notAvailable: true })
    return groupSavedVideos(await source.listMine())
  }, [source])

  const videos = loaded.data ?? []
  const current = videos.find(video => video.videoId === selected) ?? null
  const days = useMemo(() => {
    const out: Array<{ day: string; videos: SavedVideo[] }> = []
    for (const video of videos) {
      const day = uploadDay(video.uploadedAt)
      const last = out[out.length - 1]
      if (last && last.day === day) last.videos.push(video)
      else out.push({ day, videos: [video] })
    }
    return out
  }, [videos])

  useTabReselect('videos', () => { if (current) updateSelected(null) })
  useBackHandler(current ? () => { updateSelected(null); return true } : null)

  const notAvailable = loaded.error != null && (isNotAvailable(loaded.error) || (loaded.error as { notAvailable?: boolean }).notAvailable === true)

  if (current && source) {
    return (
      <section className="screen videos" aria-label="Videos">
        <VideoPlayer video={current} onBack={() => updateSelected(null)} onOpen={() => source.open({ videoId: current.videoId, url: current.url })} />
      </section>
    )
  }
  return (
    <section className="screen videos" aria-label="Videos">
      <header className="pane-head">
        <h2>Videos</h2>
        <span className="grow" />
        <button type="button" className="btn" onClick={loaded.reload} disabled={loaded.loading}>Refresh</button>
      </header>
      <div className="video-list">
        {loaded.loading && !loaded.data && <Spinner label="Loading videos" />}
        {notAvailable && !loaded.data && <NotAvailable what="Videos" />}
        {loaded.error != null && !notAvailable && !loaded.data && <ErrorState message={describeError(loaded.error)} onRetry={loaded.reload} />}
        {loaded.data && videos.length === 0 && (
          <EmptyState title="No saved videos yet">Videos you make with the desktop Video Maker, or add to a session, appear here.</EmptyState>
        )}
        {days.map(group => (
          <div key={group.day || 'unknown'} role="group" aria-label={group.day || 'Unknown date'}>
            <h3 className="video-day">{group.day || 'Unknown date'}</h3>
            {group.videos.map(video => (
              <button key={video.videoId} type="button" className="video-row" onClick={() => updateSelected(video.videoId)}
                aria-label={`${video.title}, ${PRIVACY[video.privacy] ?? video.privacy}`}>
                <span className="video-row-title">{video.title}</span>
                <span className="video-row-meta">
                  <span className={`badge badge-${video.privacy}`}>{PRIVACY[video.privacy] ?? video.privacy}</span>
                  {video.sessionIds.length > 1 ? ` ${video.sessionIds.length} sessions` : ''}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

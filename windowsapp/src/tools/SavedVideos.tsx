import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { PRIVACY_CHOICES } from './videoMakerModel'
import { formatUploadedAt, groupSavedVideos, type SavedLink, type SavedVideo, type VideoLinksApi } from './videoLinks'

interface Props {
  api: VideoLinksApi
  /** Every session of the open recording; a video saved under any of them is listed. */
  sessionIds: string[]
  /** Changes when a new link was saved, so the list reloads. */
  version: number
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The YouTube links saved with this recording's sessions. Removing one never touches the video on YouTube. */
export default function SavedVideos({ api, sessionIds, version }: Props) {
  const [videos, setVideos] = useState<SavedVideo[] | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const key = sessionIds.join('|')

  const load = useCallback(async (live: () => boolean) => {
    const settled = await Promise.allSettled(sessionIds.map(id => api.list(id)))
    if (!live()) return
    const rows: SavedLink[] = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    setVideos(groupSavedVideos(rows))
    setError(failed ? `Some saved videos could not be loaded: ${errorText(failed.reason)}` : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key])

  useEffect(() => {
    let live = true
    setVideos(null)
    void load(() => live)
    return () => { live = false }
  }, [load, version])

  const remove = async (video: SavedVideo) => {
    setConfirming(null)
    try {
      for (const id of video.sessionIds) await api.remove(id, video.videoId)
      setVideos(current => (current ? current.filter(v => v.videoId !== video.videoId) : current))
    } catch (e) { setError(`Could not remove the saved link: ${errorText(e)}`) }
  }
  const copy = async (video: SavedVideo) => {
    try { await navigator.clipboard.writeText(video.url); setCopied(video.videoId); setTimeout(() => setCopied(null), 2000) } catch { /* clipboard unavailable */ }
  }

  if (sessionIds.length === 0) return null
  return <section className="vm-card" aria-label="Saved videos">
    <div className="vm-step"><span className="vm-num">☰</span>Saved videos</div>
    <span className="vm-muted">YouTube links saved with this recording’s sessions. They are stored on the server and only you can see them.</span>
    {videos === null && !error && <span className="vm-muted" role="status">Loading saved videos…</span>}
    {videos?.length === 0 && <span className="vm-muted">Nothing saved yet. A link is saved here after each upload.</span>}
    {videos?.map(v => <div key={v.videoId} className="vm-saved">
      <div className="vm-row">
        <strong>{v.title}</strong>
        <span className="vm-muted">{PRIVACY_CHOICES.find(c => c.value === v.privacy)?.label ?? v.privacy}{formatUploadedAt(v.uploadedAt) ? ` · ${formatUploadedAt(v.uploadedAt)}` : ''}{v.sessionIds.length > 1 ? ` · ${v.sessionIds.length} sessions` : ''}</span>
      </div>
      <div className="vm-row">
        <span className="vm-path">{v.url}</span>
        <button onClick={() => void copy(v)}>{copied === v.videoId ? 'Copied' : 'Copy link'}</button>
        <button className="vm-primary" onClick={() => void invoke('youtube_open_video', { videoId: v.videoId })}>Open on YouTube</button>
        {confirming !== v.videoId && <button onClick={() => setConfirming(v.videoId)}>Remove link</button>}
      </div>
      {confirming === v.videoId && <div className="vm-row" role="alertdialog" aria-label="Confirm removing the saved link">
        <span>Remove this saved link? The video stays on YouTube.</span>
        <button className="vm-primary" onClick={() => void remove(v)}>Yes, remove</button>
        <button onClick={() => setConfirming(null)}>No</button>
      </div>}
    </div>)}
    {error && <p className="vm-error" role="alert">{error}</p>}
  </section>
}

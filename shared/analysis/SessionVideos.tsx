import { useEffect, useState } from 'react'
import { useAnalysisEnvironment } from './environment'
import AddVideoLink from './AddVideoLink'
import { EMBED_NOTE, PRIVATE_EMBED_NOTE, embedUrl, loadSavedVideos, type SavedVideo } from './videoLinks'

const muted = { color: '#8b949e', fontSize: 12 } as const
const button = { padding: '3px 10px', fontSize: 12, cursor: 'pointer' } as const
const privacyLabel = (p: string) => (p === 'private' ? 'Private' : p === 'unlisted' ? 'Unlisted' : p === 'public' ? 'Public' : p)
const dateText = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { dateStyle: 'medium' }) }

/**
 * YouTube videos uploaded for these sessions by the desktop Video Maker (links kept on the server, visible to their owner only).
 * Shows nothing when the host does not support it, or when no session has a saved video.
 * The player loads only when the viewer clicks Play here: the saved visibility cannot be trusted (it can be changed in
 * YouTube Studio) and a Private video cannot play in an embed, so the link is always there as well.
 */
export default function SessionVideos({ sessionIds, canAdd = false }: { sessionIds: string[]; canAdd?: boolean }) {
  const source = useAnalysisEnvironment().videoLinks
  const key = sessionIds.join('|')
  const [videos, setVideos] = useState<SavedVideo[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [confirming, setConfirming] = useState<string | null>(null)
  const editable = canAdd && !!source?.save

  useEffect(() => {
    if (!source) return
    let live = true
    setVideos([]); setError(''); setPlaying(null)
    void loadSavedVideos(source, sessionIds).then(result => { if (live) { setVideos(result.videos); setError(result.error) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key, version])

  if (!source || (videos.length === 0 && !error && !editable)) return null
  const copy = async (video: SavedVideo) => {
    try { await navigator.clipboard.writeText(video.url); setCopied(video.videoId); setTimeout(() => setCopied(null), 2000) } catch { /* clipboard unavailable */ }
  }
  return <div aria-label="Saved videos" style={{ margin: '0 0 12px', border: '1px solid #21262d', borderRadius: 6, background: '#0d1117' }}>
    <button onClick={() => setOpen(o => !o)} aria-expanded={open}
      style={{ width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: '#c9d1d9', cursor: 'pointer', fontSize: 13 }}>
      {open ? '▾' : '▸'} Videos{videos.length ? ` (${videos.length})` : editable ? ' — add a link' : ''}
    </button>
    {open && <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <span role="alert" style={{ color: '#f85149', fontSize: 12 }}>Some saved videos could not be loaded: {error}</span>}
      {videos.map(v => {
        const player = playing === v.videoId ? embedUrl(v.videoId) : null
        return <div key={v.videoId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{v.title}</strong>
            <span style={muted}>{privacyLabel(v.privacy)}{dateText(v.uploadedAt) ? ` · ${dateText(v.uploadedAt)}` : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={button} onClick={() => source.open({ videoId: v.videoId, url: v.url })}>Open on YouTube</button>
            <button style={button} onClick={() => void copy(v)}>{copied === v.videoId ? 'Copied' : 'Copy link'}</button>
            {editable && source.remove && confirming !== v.videoId && <button style={button} onClick={() => setConfirming(v.videoId)}>Remove link</button>}
            {embedUrl(v.videoId) && <button style={button} onClick={() => setPlaying(p => (p === v.videoId ? null : v.videoId))}>{player ? 'Hide player' : 'Play here'}</button>}
          </div>
          {confirming === v.videoId && source.remove && <div role="alertdialog" aria-label="Confirm removing the saved link" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
            <span>Remove this saved link? The video stays on YouTube.</span>
            <button style={button} onClick={() => { const remove = source.remove!; setConfirming(null); void Promise.all(v.sessionIds.map(id => remove(id, v.videoId))).then(() => setVersion(n => n + 1), e => setError(`Could not remove the link: ${e instanceof Error ? e.message : String(e)}`)) }}>Yes, remove</button>
            <button style={button} onClick={() => setConfirming(null)}>No</button>
          </div>}
          <span style={muted}>{v.privacy === 'private' ? PRIVATE_EMBED_NOTE : EMBED_NOTE}</span>
          {player && <iframe title={v.title} src={player} style={{ width: '100%', maxWidth: 640, aspectRatio: '16 / 9', border: 0, borderRadius: 4 }}
            allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
        </div>
      })}
      {editable && <AddVideoLink onAdd={async video => {
        for (const sessionId of sessionIds) await source.save!({ sessionId, videoId: video.videoId, title: video.title, privacy: video.privacy, chapters: '' })
        setVersion(n => n + 1)
      }} />}
    </div>}
  </div>
}

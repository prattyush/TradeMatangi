import { useState } from 'react'
import { lookupVideoTitle, parseYoutubeVideoId } from './videoLinks'

type Privacy = 'private' | 'unlisted' | 'public'
export const TITLE_MAX = 100
const field = { padding: '3px 6px', fontSize: 12, background: '#0d1117', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 4 } as const

/**
 * Add a YouTube video you uploaded yourself: paste its address, the title is read from YouTube when it can be (otherwise type it),
 * choose how it is labelled, and it is saved with the session. Only the video id is stored.
 */
export default function AddVideoLink({ onAdd, lookup = lookupVideoTitle }: {
  onAdd: (video: { videoId: string; title: string; privacy: Privacy }) => Promise<void>
  lookup?: (videoId: string) => Promise<string | null>
}) {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [privacy, setPrivacy] = useState<Privacy>('unlisted')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const videoId = parseYoutubeVideoId(text)

  const read = async () => {
    setNote('')
    const id = parseYoutubeVideoId(text)
    if (!text.trim()) return
    if (!id) { setNote('That is not a YouTube video address. Paste the link from the address bar or the Share button.'); return }
    if (title) return
    setBusy(true)
    const found = await lookup(id)
    setBusy(false)
    if (found) setTitle([...found].slice(0, TITLE_MAX).join(''))
    else setNote('The title could not be read from YouTube (a Private video cannot be). Type a title.')
  }
  const add = async () => {
    if (!videoId) return
    setBusy(true); setNote('')
    try { await onAdd({ videoId, title: title.trim(), privacy }); setText(''); setTitle('') }
    catch (e) { setNote(`Could not save the link: ${e instanceof Error ? e.message : String(e)}`) }
    finally { setBusy(false) }
  }
  const titleLength = [...title.trim()].length
  const ready = Boolean(videoId) && titleLength > 0 && titleLength <= TITLE_MAX && !busy
  return <div role="group" aria-label="Add a YouTube link" style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px dashed #30363d', paddingTop: 8 }}>
    <span style={{ fontSize: 12, color: '#8b949e' }}>Add a video you uploaded yourself</span>
    <input aria-label="YouTube address" placeholder="https://www.youtube.com/watch?v=…" value={text} style={field}
      onChange={e => { setText(e.target.value); setNote('') }} onBlur={() => void read()} onPaste={() => setTimeout(() => void read(), 0)} />
    <input aria-label="Video title" placeholder="Title" value={title} maxLength={TITLE_MAX + 20} style={field} onChange={e => setTitle(e.target.value)} />
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label style={{ fontSize: 12 }}>Visibility on YouTube <select value={privacy} onChange={e => setPrivacy(e.target.value as Privacy)} style={field}>
        <option value="unlisted">Unlisted</option><option value="private">Private</option><option value="public">Public</option>
      </select></label>
      <button disabled={!ready} onClick={() => void add()} style={{ padding: '3px 10px', fontSize: 12, cursor: ready ? 'pointer' : 'default' }}>{busy ? 'Working…' : 'Add link'}</button>
    </div>
    {note && <span role="status" style={{ fontSize: 12, color: '#d29922' }}>{note}</span>}
  </div>
}

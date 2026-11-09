import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  IDLE_UPLOAD, PRIVACY_CHOICES, TITLE_MAX_CHARS, applyUploadEvent, fileNameOf, privacyNotice, startUpload, uploadCannotStartReason,
  type Privacy, type UploadEvent, type UploadUi,
} from './videoMakerModel'

interface Status { connected: boolean; message?: string | null }
interface Props {
  baseUrl: string
  /** The mp4 the Video Maker just finished (offered as the video to upload). */
  output: string
  /** The chapter description shown in the Video Maker. */
  description: string
  defaultTitle: string
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * YouTube: connects the app to the user's account (upload permission only) and uploads the finished video.
 * Sign-in happens in the system browser; the token stays in Windows Credential Manager and never reaches
 * the server. The video is sent from this computer straight to YouTube.
 */
export default function YoutubeConnect({ baseUrl, output, description, defaultTitle }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [file, setFile] = useState('')
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [privacy, setPrivacy] = useState<Privacy>('private')
  const [confirming, setConfirming] = useState(false)
  const [upload, setUpload] = useState<UploadUi>(IDLE_UPLOAD)
  const [startError, setStartError] = useState('')
  const [copied, setCopied] = useState(false)
  const requested = useRef<Privacy>('private')

  const refresh = useCallback(async () => {
    try { setStatus(await invoke<Status>('youtube_status')); setError('') } catch (e) { setStatus({ connected: false }); setError(errorText(e)) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  // A newly finished video becomes the one to upload; a title the user typed is kept.
  useEffect(() => { if (output) { setFile(output); setUpload(IDLE_UPLOAD); setConfirming(false) } }, [output])
  useEffect(() => { if (!titleEdited) setTitle(defaultTitle) }, [defaultTitle, titleEdited])

  useEffect(() => {
    let un: (() => void) | undefined
    let disposed = false
    void listen<UploadEvent>('desktop-youtube-progress', event => setUpload(current => applyUploadEvent(current, event.payload))).then(f => { if (disposed) f(); else un = f })
    return () => { disposed = true; un?.() }
  }, [])

  const running = upload.state === 'running'
  const reason = uploadCannotStartReason({ connected: !!status?.connected, file, title, description, running })

  const connect = async () => {
    setBusy(true); setError('')
    try { await invoke('youtube_connect', { baseUrl }); await refresh() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true); setError('')
    try { await invoke('youtube_disconnect'); await refresh() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const chooseFile = async () => {
    try { const path = await invoke<string | null>('pick_mp4_file'); if (path) { setFile(path); setUpload(IDLE_UPLOAD); setConfirming(false) } } catch (e) { setStartError(errorText(e)) }
  }
  const doUpload = async () => {
    setConfirming(false); setStartError(''); requested.current = privacy
    try {
      const jobId = await invoke<string>('youtube_upload_start', { request: { path: file, title: title.trim(), description, privacy } })
      setUpload(current => (current.state === 'idle' ? startUpload(jobId) : current))
    } catch (e) { setUpload(IDLE_UPLOAD); setStartError(errorText(e)) }
  }
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(upload.url ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard unavailable */ }
  }
  const notice = upload.state === 'done' ? privacyNotice(requested.current, upload.privacy) : ''

  return <section className="vm-card" aria-label="YouTube">
    <div className="vm-step"><span className={`vm-num ${status?.connected ? 'done' : ''}`}>▶</span>YouTube</div>
    {status === null && <span className="vm-muted">Checking the YouTube connection…</span>}
    {status && !status.connected && <>
      <span className="vm-muted">Connect your YouTube account so finished videos can be uploaded from here. The app asks only for permission to upload; it cannot edit or delete your videos. Your browser opens so you can sign in to Google.</span>
      {status.message && <p className="vm-warn" role="status">{status.message}</p>}
      <div className="vm-row"><button className="vm-primary" onClick={() => void connect()} disabled={busy}>{busy ? 'Waiting for Google… finish in your browser' : 'Connect YouTube'}</button></div>
    </>}
    {status?.connected && <>
      <div className="vm-row">
        <span className="vm-ok" role="status">YouTube is connected.</span>
        <button onClick={() => void disconnect()} disabled={busy || running}>Disconnect</button>
      </div>

      <div className="vm-row">
        <span className="vm-path">{file ? file : 'No video chosen yet. Make a video above, or choose an mp4.'}</span>
        <button onClick={() => void chooseFile()} disabled={running}>Choose an mp4…</button>
      </div>
      <label className="vm-field">Title <span className="vm-muted">({[...title].length}/{TITLE_MAX_CHARS})</span>
        <input type="text" value={title} maxLength={TITLE_MAX_CHARS + 20} disabled={running}
          onChange={e => { setTitle(e.target.value); setTitleEdited(true) }} />
      </label>
      <div className="vm-row">
        <label>Visibility <select value={privacy} disabled={running} onChange={e => setPrivacy(e.target.value as Privacy)}>
          {PRIVACY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select></label>
        <span className="vm-muted">{description ? 'The description above is uploaded with the video.' : 'There is no description: make a cut video to get the chapter list.'}</span>
      </div>

      {!running && !confirming && <div className="vm-row">
        <button className="vm-primary" disabled={!!reason} onClick={() => setConfirming(true)}>Upload to YouTube…</button>
        {reason && file && <span className="vm-muted">{reason}</span>}
      </div>}
      {confirming && <div className="vm-row" role="alertdialog" aria-label="Confirm upload">
        <span>Upload <strong>{fileNameOf(file)}</strong> to YouTube as <strong>{PRIVACY_CHOICES.find(c => c.value === privacy)?.label}</strong>?</span>
        <button className="vm-primary" onClick={() => void doUpload()}>Yes, upload</button>
        <button onClick={() => setConfirming(false)}>No</button>
      </div>}
      {startError && <p className="vm-error" role="alert">{startError}</p>}

      {upload.state !== 'idle' && <>
        <div className="vm-bar" role="progressbar" aria-valuenow={Math.round(upload.percent)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${upload.percent}%` }} /></div>
        <span className={upload.state === 'error' ? 'vm-error' : upload.state === 'done' ? 'vm-ok' : 'vm-muted'} role={upload.state === 'error' ? 'alert' : 'status'}>
          {upload.state === 'running' ? `${Math.round(upload.percent)}% · ${upload.message}` : upload.state === 'done' ? 'Uploaded to YouTube.' : upload.message}
        </span>
        {running && <div className="vm-row"><button onClick={() => void invoke('youtube_upload_cancel')}>Cancel upload</button></div>}
      </>}
      {upload.state === 'done' && upload.url && <>
        <div className="vm-row">
          <span className="vm-path">{upload.url}</span>
          <button onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button>
          <button className="vm-primary" onClick={() => void invoke('youtube_open_video', { videoId: upload.videoId })}>Open on YouTube</button>
        </div>
        {notice && <p className="vm-warn" role="status">{notice}</p>}
        <span className="vm-muted">YouTube may take a few minutes to finish processing the video before it plays.</span>
      </>}
    </>}
    {error && <p className="vm-error" role="alert">{error}</p>}
  </section>
}

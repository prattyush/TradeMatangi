import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { changeVisibility, visibilityResultText } from './videoVisibility'
import { privacyToSave, saveOutcomeText, saveVideoUnderSessions, type VideoLinksApi } from './videoLinks'
import {
  IDLE_UPLOAD, PRIVACY_CHOICES, TITLE_MAX_CHARS, applyUploadEvent, fileNameOf, privacyNotice, startUpload, uploadCannotStartReason,
  type Privacy, type UploadEvent, type UploadUi,
} from './videoMakerModel'

interface Status { connected: boolean; canChangeVisibility?: boolean; message?: string | null }
interface Props {
  baseUrl: string
  /** The mp4 the Video Maker just finished (offered as the video to upload). */
  output: string
  /** The chapter description shown in the Video Maker. */
  description: string
  defaultTitle: string
  /** The sessions the finished video covers; the uploaded link is saved under each of them. */
  sessionIds: string[]
  linksApi: VideoLinksApi
  /** Called after a link was saved, so the list of saved videos reloads. */
  onSaved: () => void
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * YouTube: connects the app to the user's account (upload permission only) and uploads the finished video.
 * Sign-in happens in the system browser; the token stays in Windows Credential Manager and never reaches
 * the server. The video is sent from this computer straight to YouTube.
 */
export default function YoutubeConnect({ baseUrl, output, description, defaultTitle, sessionIds, linksApi, onSaved }: Props) {
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
  const uploaded = useRef({ title: '', description: '' })
  const savedFor = useRef<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [changing, setChanging] = useState(false)
  const [changingBusy, setChangingBusy] = useState(false)
  const [visibilityNote, setVisibilityNote] = useState('')
  const [appliedNow, setAppliedNow] = useState<string | null>(null)
  const [saveNote, setSaveNote] = useState('')
  const [saveFailed, setSaveFailed] = useState(false)

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

  const saveLink = useCallback(async () => {
    if (!upload.videoId) return
    setSaving(true)
    const outcome = await saveVideoUnderSessions(linksApi, sessionIds, {
      videoId: upload.videoId, title: uploaded.current.title, privacy: privacyToSave(upload.privacy, requested.current), chapters: uploaded.current.description,
    })
    setSaveNote(saveOutcomeText(outcome, sessionIds.length))
    setSaveFailed(outcome.failed.length > 0)
    setSaving(false)
    if (outcome.saved > 0) onSaved()
  }, [linksApi, sessionIds, upload.videoId, upload.privacy, onSaved])

  // Save the link with the session(s) as soon as an upload finishes (once per video).
  useEffect(() => {
    if (upload.state !== 'done' || !upload.videoId || savedFor.current === upload.videoId) return
    savedFor.current = upload.videoId
    void saveLink()
  }, [upload.state, upload.videoId, saveLink])

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
    uploaded.current = { title: title.trim(), description }
    setAppliedNow(null); setVisibilityNote(''); setChanging(false)
    setSaveNote(''); setSaveFailed(false)
    try {
      const jobId = await invoke<string>('youtube_upload_start', { request: { path: file, title: title.trim(), description, privacy } })
      setUpload(current => (current.state === 'idle' ? startUpload(jobId) : current))
    } catch (e) { setUpload(IDLE_UPLOAD); setStartError(errorText(e)) }
  }
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(upload.url ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard unavailable */ }
  }
  const currentPrivacy = appliedNow ?? upload.privacy
  const makeUnlisted = async () => {
    if (!upload.videoId) return
    setChanging(false); setChangingBusy(true); setVisibilityNote('')
    try {
      const result = await changeVisibility(
        { invoke: (command, args) => invoke(command, args), api: linksApi },
        { videoId: upload.videoId, title: uploaded.current.title, chapters: uploaded.current.description, sessionIds }, 'unlisted')
      setAppliedNow(result.applied); setVisibilityNote(visibilityResultText('unlisted', result)); onSaved()
    } catch (e) { setVisibilityNote(errorText(e)) } finally { setChangingBusy(false) }
  }
  const notice = upload.state === 'done' ? privacyNotice(requested.current, upload.privacy) : ''

  return <section className="vm-card" aria-label="YouTube">
    <div className="vm-step"><span className={`vm-num ${status?.connected ? 'done' : ''}`}>▶</span>YouTube</div>
    {status === null && <span className="vm-muted">Checking the YouTube connection…</span>}
    {status && !status.connected && <>
      <span className="vm-muted">Connect your YouTube account so finished videos can be uploaded from here. The app asks for permission to upload videos and, optionally, to manage them so it can make an uploaded video Unlisted; leave that box unticked if you only want uploading. Your browser opens so you can sign in to Google.</span>
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
        {saving ? <span className="vm-muted" role="status">Saving the link…</span>
          : saveNote && <div className="vm-row">
            <span className={saveFailed ? 'vm-warn' : 'vm-ok'} role="status">{saveNote}</span>
            {saveFailed && sessionIds.length > 0 && <button onClick={() => void saveLink()}>Save link</button>}
          </div>}
        {currentPrivacy && currentPrivacy !== 'unlisted' && <div className="vm-row">
          {status.canChangeVisibility
            ? <button onClick={() => setChanging(true)} disabled={changingBusy}>{changingBusy ? 'Changing…' : 'Make Unlisted'}</button>
            : <span className="vm-muted">To make it Unlisted from here, Disconnect and Connect YouTube again and tick the permission to manage your videos. Or change it in YouTube Studio.</span>}
        </div>}
        {changing && <div className="vm-row" role="alertdialog" aria-label="Confirm changing the visibility">
          <span>Make this video Unlisted on YouTube? Anyone who has the link can watch it.</span>
          <button className="vm-primary" onClick={() => void makeUnlisted()}>Yes, make it Unlisted</button>
          <button onClick={() => setChanging(false)}>No</button>
        </div>}
        {visibilityNote && <p className="vm-warn" role="status">{visibilityNote}</p>}
        <span className="vm-muted">YouTube may take a few minutes to finish processing the video before it plays.</span>
      </>}
    </>}
    {error && <p className="vm-error" role="alert">{error}</p>}
  </section>
}

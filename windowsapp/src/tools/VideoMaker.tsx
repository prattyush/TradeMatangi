import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { analysisRequest, createAnalysisApi, type AnalysisRequest } from '../analysisApi'
import type { RecordingMeta } from '../../../shared/recordingMeta'
import type { RoundTripLike } from './tradeWindows'
import { formatTimestamp } from './chapters'
import YoutubeConnect from './YoutubeConnect'
import { videoDurationSec } from './videoTimeline'
import {
  CANDLE_CHOICES, IDLE_JOB, applyVideoEvent, buildJobRequest, cannotStartReason, computeVideoPlan, defaultCandleSeconds, defaultVideoTitle, descriptionPathFor,
  describeSession, formatDuration, marketClock, pairingWarning, parseRecordingMeta, statusLabel, suggestedOutputName,
  type JobUi, type VideoEvent,
} from './videoMakerModel'

interface Props { baseUrl: string; token: string; onUnauthorized: () => void }
interface Picked { videoPath: string; metaJson: string | null }

const native = '__TAURI_INTERNALS__' in window
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const pctClass = (v: number | null) => (v === null ? 'dim' : v >= 0 ? 'pos' : 'neg')
const pctText = (v: number | null) => (v === null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`)

/** Trading Video Maker: cuts a screen recording down to its trades and writes the YouTube chapter list. */
export default function VideoMaker({ baseUrl, token, onUnauthorized }: Props) {
  const adapter = useMemo(() => {
    const request: AnalysisRequest | undefined = native
      ? <T,>(path: string, method: string, body?: unknown) => invoke<T>('desktop_analysis_request', { baseUrl, path, method, body: body ?? {} })
      : undefined
    return createAnalysisApi(analysisRequest(baseUrl, token, request, onUnauthorized))
  }, [baseUrl, token, onUnauthorized])

  const [ffmpeg, setFfmpeg] = useState<{ available: boolean; version?: string | null } | null>(null)
  const [videoPath, setVideoPath] = useState('')
  const [meta, setMeta] = useState<RecordingMeta | null>(null)
  const [needsMetaFile, setNeedsMetaFile] = useState(false)
  const [fileError, setFileError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [candleSeconds, setCandleSeconds] = useState(180)
  const [nudge, setNudge] = useState(0)
  const [trips, setTrips] = useState<Record<string, RoundTripLike[]>>({})
  const [tripsError, setTripsError] = useState('')
  const [tripsLoading, setTripsLoading] = useState(false)
  const [mode, setMode] = useState<'cut' | 'convert'>('cut')
  const [output, setOutput] = useState('')
  const [job, setJob] = useState<JobUi>(IDLE_JOB)
  const [startError, setStartError] = useState('')
  const [description, setDescription] = useState('')
  const [copied, setCopied] = useState(false)
  const [descSaved, setDescSaved] = useState('')
  const jobRef = useRef(job)
  jobRef.current = job

  useEffect(() => {
    if (!native) { setFfmpeg({ available: false }); return }
    let live = true
    void invoke<{ available: boolean; version?: string | null }>('ffmpeg_status').then(s => { if (live) setFfmpeg(s) }).catch(() => { if (live) setFfmpeg({ available: false }) })
    return () => { live = false }
  }, [])

  // Progress events from the Rust job runner.
  useEffect(() => {
    if (!native) return
    let un: (() => void) | undefined
    let disposed = false
    void listen<VideoEvent>('desktop-video-progress', event => setJob(current => applyVideoEvent(current, event.payload))).then(f => { if (disposed) f(); else un = f })
    return () => { disposed = true; un?.() }
  }, [])

  const acceptMeta = useCallback((json: string, path: string) => {
    const parsed = parseRecordingMeta(json)
    if (!parsed.meta) { setMeta(null); setFileError(parsed.error); return }
    const ids = parsed.meta.sessions.map(s => s.sessionId)
    setMeta(parsed.meta)
    setNeedsMetaFile(false)
    setSelected(ids)
    setCandleSeconds(defaultCandleSeconds(parsed.meta, ids))
    setNudge(0)
    setTrips({})
    setFileError(pairingWarning(parsed.meta, path))
  }, [])

  const chooseRecording = async () => {
    setStartError('')
    try {
      const picked = await invoke<Picked | null>('pick_recording')
      if (!picked) return
      setVideoPath(picked.videoPath)
      setJob(IDLE_JOB)
      setDescription('')
      setDescSaved('')
      setOutput('')
      setMeta(null)
      setFileError('')
      if (picked.metaJson) acceptMeta(picked.metaJson, picked.videoPath)
      else setNeedsMetaFile(true)
    } catch (e) { setFileError(errorText(e)) }
  }

  const chooseMetaFile = async () => {
    try {
      const json = await invoke<string | null>('pick_meta_file')
      if (json) acceptMeta(json, videoPath)
    } catch (e) { setFileError(errorText(e)) }
  }

  // Load the round trips of the selected sessions from the server.
  useEffect(() => {
    if (!meta) return
    const missing = selected.filter(id => !(id in trips))
    if (missing.length === 0) return
    let live = true
    setTripsLoading(true)
    setTripsError('')
    void Promise.all(missing.map(async id => [id, await adapter.api.getRoundTrips!(id)] as const)).then(rows => {
      if (!live) return
      setTrips(current => ({ ...current, ...Object.fromEntries(rows.map(([id, list]) => [id, list as unknown as RoundTripLike[]])) }))
    }).catch(e => {
      if (!live || (e instanceof DOMException && e.name === 'AbortError')) return
      setTripsError(`Could not load the trades for this session from ${baseUrl}: ${errorText(e)}. Make sure the app is connected to the server that holds the session.`)
    }).finally(() => { if (live) setTripsLoading(false) })
    return () => { live = false }
  }, [adapter, baseUrl, meta, selected, trips])

  const ready = Boolean(meta) && selected.every(id => id in trips)
  const result = useMemo(
    () => (meta && ready ? computeVideoPlan({ meta, selectedSessionIds: selected, tripsBySession: trips, candleSeconds, nudgeSec: nudge }) : null),
    [meta, ready, selected, trips, candleSeconds, nudge],
  )
  useEffect(() => { if (result && job.state !== 'done') setDescription(result.chapters.text) }, [result, job.state])

  const running = job.state === 'running'
  const blocked = cannotStartReason({ ffmpegAvailable: ffmpeg?.available ?? null, hasMeta: Boolean(meta), mode, plan: result?.plan ?? null, output, running })
  const totalSec = meta ? videoDurationSec(meta) : 0

  const chooseOutput = async () => {
    try {
      const path = await invoke<string | null>('pick_output_file', { suggestedName: suggestedOutputName(videoPath, mode), folder: null })
      if (path) setOutput(path)
    } catch (e) { setStartError(errorText(e)) }
  }

  const start = async () => {
    setStartError('')
    setDescSaved('')
    setJob({ ...IDLE_JOB, state: 'running', message: 'Starting…' })
    try {
      const id = await invoke<string>('video_job_start', { request: buildJobRequest({ input: videoPath, output, mode, plan: result?.plan ?? null, totalSec }) })
      setJob(current => (current.state === 'running' && current.jobId === null ? { ...current, jobId: id } : current))
    } catch (e) {
      setJob(IDLE_JOB)
      setStartError(errorText(e))
    }
  }

  // When a cut finishes, save the description beside the video.
  useEffect(() => {
    if (job.state !== 'done' || !job.output || mode !== 'cut' || !description) return
    const path = descriptionPathFor(job.output)
    void invoke('write_text_file', { path, contents: description }).then(() => setDescSaved(path)).catch(e => setDescSaved(`Could not save the description: ${errorText(e)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.state, job.output])

  const copy = async () => {
    try { await navigator.clipboard.writeText(description); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard unavailable */ }
  }

  if (!native) return <div className="vm"><h2>Trading Video Maker</h2><p className="vm-error">The Video Maker works in the Trade Matangi desktop app only.</p></div>

  const plan = result?.plan
  const multi = selected.length > 1
  return <div className="vm">
    <div>
      <h2>Trading Video Maker</h2>
      <p className="vm-lead">Turn a screen recording into an mp4 you can seek, cut down to the minutes around your trades, with a chapter list for YouTube. Everything runs on this computer.</p>
    </div>
    {ffmpeg?.available === false && <p className="vm-error" role="alert">ffmpeg was not found, so videos cannot be made. Reinstall the app.</p>}

    <section className="vm-card">
      <div className="vm-step"><span className={`vm-num ${meta ? 'done' : ''}`}>1</span>Choose the recording</div>
      <div className="vm-row">
        <button className="vm-primary" onClick={() => void chooseRecording()} disabled={running}>{videoPath ? 'Choose another…' : 'Choose recording…'}</button>
        {videoPath && <span className="vm-path">{videoPath}</span>}
      </div>
      {!videoPath && <span className="vm-muted">Pick the .webm you saved with “Record screen”. Its .rec.json file is found automatically if it sits in the same folder.</span>}
      {needsMetaFile && <div className="vm-row"><span className="vm-warn">No .rec.json was found beside this video.</span><button onClick={() => void chooseMetaFile()}>Choose the .rec.json…</button></div>}
      {fileError && <p className={meta ? 'vm-warn' : 'vm-error'} role="alert">{fileError}</p>}
      {needsMetaFile && <span className="vm-muted">Only recordings made with a version of the app that saves the .rec.json can be cut. “Convert whole video” below works for any recording.</span>}
    </section>

    {meta && <section className="vm-card">
      <div className="vm-step"><span className={`vm-num ${result ? 'done' : ''}`}>2</span>Choose what to keep</div>
      <div className="vm-sessions" role="group" aria-label="Sessions in this recording">
        <label><input type="checkbox" checked={selected.length === meta.sessions.length} onChange={e => setSelected(e.target.checked ? meta.sessions.map(s => s.sessionId) : [])} disabled={running} /> All sessions in this recording</label>
        {meta.sessions.map(s => <label key={s.sessionId}>
          <input type="checkbox" checked={selected.includes(s.sessionId)} disabled={running}
            onChange={e => setSelected(cur => (e.target.checked ? [...cur, s.sessionId] : cur.filter(x => x !== s.sessionId)))} /> {describeSession(s)}
        </label>)}
      </div>
      <div className="vm-row">
        <label>Candle interval <select value={candleSeconds} onChange={e => setCandleSeconds(Number(e.target.value))} disabled={running}>
          {[...new Set([...CANDLE_CHOICES, candleSeconds])].sort((a, b) => a - b).map(v => <option key={v} value={v}>{v / 60} min</option>)}
        </select></label>
        <label title="Move every cut earlier (−) or later (+) if the video is slightly out of step with the trades">Shift video <input type="number" step="1" min="-60" max="60" value={nudge} onChange={e => setNudge(Number(e.target.value) || 0)} disabled={running} /> s</label>
        <span className="vm-muted">Each cut starts one candle before an entry and ends one candle after the exit.</span>
      </div>
      {tripsLoading && <span className="vm-muted" role="status">Loading trades…</span>}
      {tripsError && <p className="vm-error" role="alert">{tripsError}</p>}
      {selected.length === 0 && <p className="vm-warn">Select at least one session.</p>}

      {result && plan && <>
        <div className="vm-stats">
          <div className="vm-stat"><b>{result.trades.length}</b><span>Trades</span></div>
          <div className="vm-stat"><b>{plan.trades.filter(t => t.status === 'in-video').length}</b><span>In this video</span></div>
          <div className="vm-stat"><b>{formatDuration(plan.videoDurationSec)}</b><span>Recording</span></div>
          <div className="vm-stat"><b>{formatDuration(plan.keptDurationSec)}</b><span>After cutting</span></div>
        </div>
        {plan.videoDurationSec > 0 && <div className="vm-timeline" aria-label="Parts of the recording that are kept">
          {plan.windows.map((w, i) => <i key={i} style={{ left: `${(w.startSec / plan.videoDurationSec) * 100}%`, width: `${((w.endSec - w.startSec) / plan.videoDurationSec) * 100}%` }} title={`${formatTimestamp(w.startSec, false)} – ${formatTimestamp(w.endSec, false)}`} />)}
        </div>}
        {result.trades.length === 0
          ? <p className="vm-warn">No trades were found for the selected sessions.</p>
          : <div className="vm-table-wrap"><table>
            <thead><tr><th className="num">#</th>{multi && <th>Session</th>}<th>Contract</th><th>Entry</th><th>Exit</th><th className="num">P&amp;L</th><th>Status</th><th className="num">At</th></tr></thead>
            <tbody>{plan.trades.map(t => {
              const session = meta.sessions.find(s => s.sessionId === t.sessionId)
              return <tr key={t.key}>
                <td className="num">{t.number}</td>{multi && <td>{session ? `${session.symbol} ${sessionShort(session.date)}` : t.sessionId.slice(0, 6)}</td>}
                <td>{t.label}</td><td>{marketClock(t.entryTime)}</td><td>{t.exitTime === null ? 'open' : marketClock(t.exitTime)}</td>
                <td className={`num ${pctClass(t.pnlPct)}`}>{pctText(t.pnlPct)}</td>
                <td className={t.status === 'in-video' ? '' : 'dim'}>{statusLabel(t)}</td>
                <td className="num">{t.outputEntrySec === null ? '—' : formatTimestamp(t.outputEntrySec, false)}</td>
              </tr>
            })}</tbody>
          </table></div>}
        {result.chapters.warnings.map(w => <p key={w} className="vm-warn">{w}</p>)}
      </>}
    </section>}

    <section className="vm-card" data-disabled={!videoPath}>
      <div className="vm-step"><span className={`vm-num ${job.state === 'done' ? 'done' : ''}`}>3</span>Make the video</div>
      <div className="vm-row" role="radiogroup" aria-label="What to make">
        <label><input type="radio" name="vm-mode" checked={mode === 'cut'} onChange={() => { setMode('cut'); setOutput('') }} disabled={running || !videoPath} /> Cut to my trades</label>
        <label><input type="radio" name="vm-mode" checked={mode === 'convert'} onChange={() => { setMode('convert'); setOutput('') }} disabled={running || !videoPath} /> Convert the whole recording to mp4</label>
      </div>
      <div className="vm-row">
        <button onClick={() => void chooseOutput()} disabled={running || !videoPath}>Save as…</button>
        {output ? <span className="vm-path">{output}</span> : <span className="vm-muted">Choose where to save the mp4.</span>}
      </div>
      <div className="vm-row">
        <button className="vm-primary" disabled={Boolean(blocked)} title={blocked} onClick={() => void start()}>Make video</button>
        {running && <button onClick={() => void invoke('video_job_cancel')}>Cancel</button>}
        {blocked && !running && <span className="vm-muted">{blocked}</span>}
      </div>
      {startError && <p className="vm-error" role="alert">{startError}</p>}
      {job.state !== 'idle' && <>
        <div className="vm-bar" role="progressbar" aria-valuenow={Math.round(job.percent)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${job.percent}%` }} /></div>
        <span className={job.state === 'error' ? 'vm-error' : job.state === 'done' ? 'vm-ok' : 'vm-muted'} role={job.state === 'error' ? 'alert' : 'status'}>
          {job.state === 'running' ? `${Math.round(job.percent)}% · ${job.message}` : job.state === 'done' ? `Finished · ${formatDuration(job.keptSec ?? 0)} of video · ${job.encoder ?? ''}` : job.message}
        </span>
      </>}
      {job.state === 'done' && job.output && <div className="vm-row">
        <span className="vm-path">{job.output}</span>
        <button onClick={() => void invoke('reveal_in_folder', { path: job.output })}>Show in folder</button>
      </div>}
    </section>

    {mode === 'cut' && result && <section className="vm-card">
      <div className="vm-step"><span className="vm-num">✎</span>YouTube description</div>
      <span className="vm-muted">Paste this into the video description. The times are positions in the finished video.</span>
      <textarea aria-label="YouTube description" value={description} onChange={e => setDescription(e.target.value)} spellCheck={false} />
      <div className="vm-row">
        <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy description'}</button>
        {descSaved && <span className="vm-muted">{descSaved.startsWith('Could not') ? descSaved : `Saved to ${descSaved}`}</span>}
      </div>
    </section>}

    <YoutubeConnect baseUrl={baseUrl} output={job.state === 'done' ? job.output ?? '' : ''} description={mode === 'cut' ? description : ''} defaultTitle={defaultVideoTitle(meta, selected)} />
  </div>
}

function sessionShort(date: string): string {
  return date.slice(5)
}

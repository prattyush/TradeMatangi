import { useState, useRef, useCallback, useEffect } from 'react'
import { RecordingMetaRecorder, SessionEndWatcher, metaFileName, type RecordingClock, type RecordingClockSession, type RecordingSource } from './recordingMeta'

export type RecordingState = 'idle' | 'requesting' | 'recording' | 'paused'

const MIME_PRIORITY = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

function pickMimeType(): string {
  for (const mime of MIME_PRIORITY) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

const SAMPLE_INTERVAL_MS = 1000
export const SESSION_ENDED_NOTICE = 'Recording stopped because the trading session ended. The video and its .rec.json were saved.'

/**
 * `clock` (optional) reports the sessions on screen so a `<video>.rec.json` file can be saved
 * beside the video. It is read through a ref, so it may change on every render.
 */
export function useRecording(clock?: RecordingClock, source: RecordingSource = 'website') {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const filenameRef = useRef<string>('TradeMatangi_recording.webm')
  const clockRef = useRef<RecordingClock | undefined>(clock)
  clockRef.current = clock
  const metaRef = useRef<RecordingMetaRecorder | null>(null)
  const samplerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const endWatcherRef = useRef<SessionEndWatcher | null>(null)

  const stopSampler = useCallback(() => {
    if (samplerRef.current !== null) clearInterval(samplerRef.current)
    samplerRef.current = null
  }, [])

  /** Metadata must never break recording: every call into it is guarded. */
  const withMeta = useCallback((fn: (meta: RecordingMetaRecorder) => void) => {
    try {
      if (metaRef.current) fn(metaRef.current)
    } catch {
      // ignore
    }
  }, [])

  const triggerDownload = useCallback((chunks: Blob[], mimeType: string, filename: string) => {
    const blob = new Blob(chunks, { type: mimeType || 'video/webm' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [])

  const downloadMeta = useCallback((videoFilename: string) => {
    const meta = metaRef.current
    metaRef.current = null
    if (!meta) return
    try {
      meta.stop()
      const blob = new Blob([JSON.stringify(meta.toJSON())], { type: 'application/json' })
      // Slight delay so the browser treats this as a separate download from the video.
      setTimeout(() => triggerDownload([blob], 'application/json', metaFileName(videoFilename)), 400)
    } catch {
      // The video has already been saved; a missing metadata file is the only effect.
    }
  }, [triggerDownload])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (recorder.state === 'inactive') return

    recorder.stop()
    // Stream tracks stopped inside onstop to ensure all data is flushed first
  }, [])

  /** One sampler tick: reads the clock once, saves a sample, and stops the recording when the session has ended. */
  const tick = useCallback(() => {
    let sessions: RecordingClockSession[] | undefined
    try {
      sessions = clockRef.current?.()
    } catch {
      sessions = undefined
    }
    withMeta(m => m.sample(sessions ? () => sessions! : undefined))
    if (!sessions) return
    try {
      if (endWatcherRef.current?.observe(sessions, Date.now()) === 'stop') {
        endWatcherRef.current = null
        setRecordingNotice(SESSION_ENDED_NOTICE)
        stopRecording()
      }
    } catch {
      // Never let the watcher break recording.
    }
  }, [withMeta, stopRecording])

  const startRecording = useCallback(async (filename: string) => {
    setRecordingError(null)
    setRecordingNotice(null)

    // getDisplayMedia requires a secure context (HTTPS or localhost)
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
      setRecordingError('Screen recording requires HTTPS or localhost')
      return
    }

    setRecordingState('requesting')
    filenameRef.current = filename

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } } as MediaTrackConstraints,
        audio: true,
      })
    } catch (err) {
      setRecordingState('idle')
      // NotAllowedError = user dismissed the picker — show nothing
      if (err instanceof Error && err.name !== 'NotAllowedError') {
        setRecordingError(err.message || 'Screen capture failed')
      }
      return
    }

    streamRef.current = stream
    chunksRef.current = []

    const mimeType = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch {
      stream.getTracks().forEach(t => t.stop())
      setRecordingState('idle')
      setRecordingError('MediaRecorder failed to initialise')
      return
    }

    recorderRef.current = recorder

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = () => {
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      recorderRef.current = null
      stopSampler()
      endWatcherRef.current = null
      triggerDownload(chunksRef.current, mimeType, filenameRef.current)
      downloadMeta(filenameRef.current)
      chunksRef.current = []
      setRecordingState('idle')
    }

    // When the user clicks the browser's own "Stop sharing" button the video track ends
    stream.getVideoTracks().forEach(track => {
      track.addEventListener('ended', () => {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop()
        }
      })
    })

    recorder.start(1000) // collect data every second
    setRecordingState('recording')

    try {
      const meta = new RecordingMetaRecorder({ source, videoFile: filename })
      meta.start()
      metaRef.current = meta
      meta.sample(clockRef.current)
      endWatcherRef.current = new SessionEndWatcher()
      stopSampler()
      samplerRef.current = setInterval(tick, SAMPLE_INTERVAL_MS)
    } catch {
      metaRef.current = null
    }
  }, [triggerDownload, downloadMeta, stopSampler, withMeta, tick, source])

  const pauseRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.pause()
      withMeta(m => m.pause())
      setRecordingState('paused')
    }
  }, [withMeta])

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state === 'paused') {
      recorderRef.current.resume()
      withMeta(m => m.resume())
      setRecordingState('recording')
    }
  }, [withMeta])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (samplerRef.current !== null) clearInterval(samplerRef.current)
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
      }
    }
  }, [])

  return { recordingState, recordingError, recordingNotice, startRecording, pauseRecording, resumeRecording, stopRecording }
}

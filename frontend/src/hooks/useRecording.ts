import { useState, useRef, useCallback, useEffect } from 'react'

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

export function useRecording() {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [recordingError, setRecordingError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const filenameRef = useRef<string>('TradeMatangi_recording.webm')

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

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (recorder.state === 'inactive') return

    recorder.stop()
    // Stream tracks stopped inside onstop to ensure all data is flushed first
  }, [])

  const startRecording = useCallback(async (filename: string) => {
    setRecordingError(null)

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
      triggerDownload(chunksRef.current, mimeType, filenameRef.current)
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
  }, [triggerDownload])

  const pauseRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.pause()
      setRecordingState('paused')
    }
  }, [])

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state === 'paused') {
      recorderRef.current.resume()
      setRecordingState('recording')
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
      }
    }
  }, [])

  return { recordingState, recordingError, startRecording, pauseRecording, resumeRecording, stopRecording }
}

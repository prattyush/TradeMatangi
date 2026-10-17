export type SwingStreamEvent = Record<string, any>
export type SwingSubscribe = (path: string, onEvent: (event: SwingStreamEvent) => void, onError: (error: unknown) => void) => () => void

/** Decode split UTF-8/SSE frames, including named events and keepalive comments. */
export class SwingSseDecoder {
  private decoder = new TextDecoder()
  private buffer = ''
  constructor(private deliver: (event: SwingStreamEvent) => void) {}
  push(bytes: Uint8Array) {
    this.buffer = (this.buffer + this.decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n')
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      const event = JSON.parse(data)
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Swing stream event')
      this.deliver(event)
    }
    if (this.buffer.length > 2_000_000) throw new Error('Swing stream frame too large')
  }
}

/** Authenticated fetch permits headers; reconnects receive a fresh server snapshot. */
export function browserSwingSubscribe(base: string, headers: () => HeadersInit): SwingSubscribe {
  return (path, onEvent, onError) => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let backoff = 1000
    const connect = async () => {
      try {
        const response = await fetch(`${base}/${path}`, { headers: headers(), signal: abort.signal })
        if (response.status === 404 && path.includes('/charts/watch/')) {
          if (!abort.signal.aborted) onEvent({ type: 'chart_watch_expired' })
          return
        }
        if (!response.ok || !response.body) throw new Error(`Swing stream failed (${response.status})`)
        const reader = response.body.getReader()
        const decoder = new SwingSseDecoder(event => { if (!abort.signal.aborted) onEvent(event) })
        try {
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) throw new Error('Swing stream disconnected')
            backoff = 1000
            decoder.push(value)
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      } catch (error) {
        if (abort.signal.aborted) return
        onError(error)
        timer = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
    void connect()
    return () => { abort.abort(); if (timer !== undefined) clearTimeout(timer) }
  }
}

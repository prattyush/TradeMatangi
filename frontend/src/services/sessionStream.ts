export interface SessionStreamOptions {
  sessionId: string
  url: (cursor: string | null) => string
  probe: () => Promise<unknown>
  onMessage: (event: Record<string, unknown>) => void
  onReconnect: () => void
  onUnavailable: () => void
  createSource?: (url: string) => EventSource
}

/** Own one session's SSE connection, including fenced probes and retry timers. */
export class SessionStream {
  private source: EventSource | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private revision = 0
  private closed = false
  private terminal = false
  private delay = 1000
  private cursor: string | null = null
  private opened = false

  constructor(private readonly options: SessionStreamOptions) {}

  get connected(): boolean { return this.source !== null }

  connect(resetBackoff = false): void {
    if (this.closed || this.terminal) return
    if (resetBackoff) this.delay = 1000
    this.source?.close()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const revision = ++this.revision
    const source = (this.options.createSource ?? (url => new EventSource(url)))(this.options.url(this.cursor))
    this.source = source
    const current = () => !this.closed && !this.terminal && this.revision === revision
    source.onopen = () => {
      if (!current()) return
      this.delay = 1000
      if (this.opened) this.options.onReconnect()
      this.opened = true
    }
    source.onmessage = event => {
      if (!current()) return
      let payload: Record<string, unknown>
      try { payload = JSON.parse(event.data) as Record<string, unknown> } catch { return }
      if (event.lastEventId) this.cursor = event.lastEventId
      if (payload.type === 'stream_reset') this.options.onReconnect()
      else this.options.onMessage({ ...payload, session_id: this.options.sessionId })
      this.delay = 1000
      if (payload.type === 'session_ended') {
        this.terminal = true
        source.close()
        this.source = null
      }
    }
    source.onerror = () => {
      if (!current() || this.source !== source) return
      source.close()
      this.source = null
      void this.options.probe().then(() => {
        if (current()) this.retry(revision)
      }).catch((error: unknown) => {
        if (!current()) return
        const status = error && typeof error === 'object' && 'status' in error ? error.status : null
        if (status === 404 || status === 410) {
          this.terminal = true
          this.options.onUnavailable()
        } else this.retry(revision)
      })
    }
  }

  private retry(revision: number): void {
    if (this.closed || this.terminal || this.revision !== revision) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.closed || this.terminal || this.revision !== revision) return
      this.delay = Math.min(this.delay * 2, 30000)
      this.connect()
    }, this.delay)
  }

  close(): void {
    this.closed = true
    ++this.revision
    this.source?.close()
    this.source = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

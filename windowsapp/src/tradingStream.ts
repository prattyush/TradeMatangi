import type { DesktopTradingSnapshot } from './contracts'
import { applyPaperStreamEvent, isDesktopTradingSnapshot } from './paperTradingState'
import { eventNeedsTradingRefresh, eventAffectsWallet } from './tradingRefresh'

type Event = Record<string, unknown>

/** Handles partial UTF-8/SSE frames without holding delivery for recovery. */
export class TradingSseDecoder {
  private decoder = new TextDecoder()
  private buffer = ''
  constructor(private onEvent: (event: Event, id: number | undefined) => void, private onInvalidFrame: () => void) {}
  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    // Normalize only complete CRLF pairs; a chunk may finish between CR and LF.
    this.buffer = this.buffer.replace(/\r\n/g, '\n')
    let end = this.buffer.indexOf('\n\n')
    while (end >= 0) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const lines = frame.split('\n')
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      const idText = lines.find(line => line.startsWith('id:'))?.slice(3).trim()
      if (data) {
        let event: unknown
        try { event = JSON.parse(data) } catch { this.onInvalidFrame(); end = this.buffer.indexOf('\n\n'); continue }
        if (!event || typeof event !== 'object' || Array.isArray(event)) this.onInvalidFrame()
        else this.onEvent(event as Event, idText && Number.isFinite(Number(idText)) ? Number(idText) : undefined)
      }
      end = this.buffer.indexOf('\n\n')
    }
  }
}

/** Replays events received while an authoritative recovery request is pending. */
export class TradingEventJournal {
  private events: Event[] = []
  private droppedThrough = -1
  constructor(private limit = 2048) {}

  record(event: Event): void {
    if (isDesktopTradingSnapshot(event)) return
    this.events.push(event)
    if (this.events.length > this.limit) {
      const removed = this.events.shift()!
      this.droppedThrough = Math.max(this.droppedThrough, Number(removed.event_id) || 0)
    }
  }

  gapThrough(cursor: number): void {
    this.droppedThrough = Math.max(this.droppedThrough, cursor)
  }

  reconcile(current: DesktopTradingSnapshot, incoming: DesktopTradingSnapshot): { snapshot: DesktopTradingSnapshot; retry: boolean } {
    if (incoming.session.session_id !== current.session.session_id) return { snapshot: current, retry: true }
    const cursor = incoming.event_cursor ?? 0
    if (cursor < this.droppedThrough) return { snapshot: current, retry: true }
    let snapshot = incoming
    let retry = false
    for (const event of this.events) {
      const id = Number(event.event_id)
      if (!Number.isFinite(id) || id > cursor) {
        retry ||= eventNeedsTradingRefresh(event, snapshot.event_cursor ?? -1)
        retry ||= eventAffectsWallet(event) && typeof event.wallet_balance !== 'number'
        snapshot = applyPaperStreamEvent(snapshot, event)
      }
    }
    if ((snapshot.event_cursor ?? 0) < (current.event_cursor ?? 0)) return { snapshot: current, retry: true }
    this.events = this.events.filter(event => Number(event.event_id) > cursor)
    return { snapshot, retry }
  }
}

interface StreamCallbacks {
  current: () => DesktopTradingSnapshot | null
  publish: (snapshot: DesktopTradingSnapshot) => void
  fetchSnapshot: () => Promise<DesktopTradingSnapshot>
  fetchWallet?: () => Promise<{ balance: number }>
  onError: (error: unknown) => void
  onRecovery?: (elapsedMs: number) => void
}

/** Snapshot requests never hold the stream reader or block incremental events. */
export class TradingStreamController {
  private journal = new TradingEventJournal()
  private stopped = false
  private pending = false
  private required = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private backoff = 1000
  private recoveryVersion = 0
  private epoch = 0
  private recoveryRequest: Promise<void> | undefined
  private walletVersion = 0
  private walletRequired = false
  private walletPending = false
  private walletRetry: ReturnType<typeof setTimeout> | undefined
  private walletBackoff = 1000
  constructor(private callbacks: StreamCallbacks) {}

  receive(events: Event[], gap = false): void {
    if (this.stopped) return
    let current = this.callbacks.current()
    if (!current) return
    let recover = gap
    if (gap) {
      const first = events[0]
      const cursor = first && isDesktopTradingSnapshot(first) ? first.event_cursor ?? 0 : Number(first?.event_id) - 1
      this.journal.gapThrough(Number.isFinite(cursor) ? cursor : current.event_cursor ?? 0)
    }
    for (const event of events) {
      if (isDesktopTradingSnapshot(event)) {
        if (event.stream_reconnected) {
          this.epoch++
          this.required = false
          if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
          this.journal = new TradingEventJournal()
          current = event
          recover = false
        } else {
          const reconciled = this.journal.reconcile(current, event)
          current = reconciled.snapshot
          recover ||= reconciled.retry
        }
        this.walletVersion++
        this.walletRequired = false
      } else {
        const id = Number(event.event_id)
        if (Number.isFinite(id) && id <= (current.event_cursor ?? -1)) continue
        if (Number.isFinite(id) && (current.event_cursor ?? -1) >= 0 && id > current.event_cursor! + 1) {
          recover = true
          this.journal.gapThrough(id - 1)
        }
        recover ||= eventNeedsTradingRefresh(event, current.event_cursor ?? -1)
        if (eventAffectsWallet(event)) {
          this.walletVersion++
          this.walletRequired = typeof event.wallet_balance !== 'number'
        }
        this.journal.record(event)
        current = applyPaperStreamEvent(current, event)
      }
    }
    this.callbacks.publish(current)
    if (recover) void this.recover()
    else this.refreshWallet()
  }

  recover(immediate = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (immediate && this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    this.required = true
    this.recoveryVersion++
    if (this.pending || this.retryTimer !== undefined) return this.recoveryRequest ?? Promise.resolve()
    this.pending = true
    this.required = false
    const version = this.recoveryVersion
    const epoch = this.epoch
    const started = performance.now()
    this.recoveryRequest = this.callbacks.fetchSnapshot().then(incoming => {
      if (this.stopped || epoch !== this.epoch) return
      const current = this.callbacks.current()
      if (!current) return
      const result = this.journal.reconcile(current, incoming)
      this.required = result.retry || this.recoveryVersion !== version
      this.walletVersion++
      if (!result.retry) this.walletRequired = false
      this.callbacks.publish(result.snapshot)
      this.callbacks.onRecovery?.(performance.now() - started)
      this.backoff = 1000
    }).catch(error => {
      if (this.stopped || epoch !== this.epoch) return
      this.required = true
      this.callbacks.onError(error)
      this.backoff = Math.min(this.backoff * 2, 30_000)
    }).finally(() => {
      this.pending = false
      this.recoveryRequest = undefined
      if (!this.stopped && this.required) {
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.recover() }, this.backoff)
      } else this.refreshWallet()
    })
    return this.recoveryRequest
  }

  private refreshWallet(): void {
    if (this.stopped || !this.walletRequired || !this.callbacks.fetchWallet || this.pending || this.retryTimer !== undefined || this.walletPending || this.walletRetry !== undefined) return
    this.walletPending = true
    this.walletRequired = false
    const version = this.walletVersion
    let failed = false
    void this.callbacks.fetchWallet().then(wallet => {
      if (this.stopped || version !== this.walletVersion) return
      if (!Number.isFinite(wallet.balance)) throw new Error('Invalid wallet balance')
      const current = this.callbacks.current()
      if (current) this.callbacks.publish({ ...current, wallet_balance: wallet.balance })
      this.walletBackoff = 1000
    }).catch(error => {
      if (this.stopped) return
      failed = true
      if (version !== this.walletVersion && !this.walletRequired) return
      this.walletRequired = true
      this.callbacks.onError(error)
      this.walletBackoff = Math.min(this.walletBackoff * 2, 30_000)
    }).finally(() => {
      this.walletPending = false
      if (!this.stopped && this.walletRequired) {
        this.walletRetry = setTimeout(() => { this.walletRetry = undefined; this.refreshWallet() }, failed ? this.walletBackoff : 0)
      }
    })
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    if (this.walletRetry !== undefined) clearTimeout(this.walletRetry)
  }
}

/** Coalesces wakeups without losing one that arrives during a native IPC read. */
export class TradingStreamDrain {
  private running = false
  private requested = false
  private stopped = false
  constructor(private read: () => Promise<void>, private onError: (error: unknown) => void) {}
  async wake(): Promise<void> {
    if (this.stopped) return
    this.requested = true
    if (this.running) return
    this.running = true
    try {
      while (this.requested && !this.stopped) {
        this.requested = false
        await this.read()
      }
    } catch (error) { if (!this.stopped) this.onError(error) }
    finally { this.running = false }
  }
  stop(): void { this.stopped = true }
}

/** Orders native startup/cleanup even when an IPC command finishes after unmount. */
export class TradingStreamLifecycle {
  private tasks = new Map<string, Promise<void>>()
  run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tasks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.tasks.set(key, next)
    void next.finally(() => { if (this.tasks.get(key) === next) this.tasks.delete(key) }).catch(() => undefined)
    return next
  }
}

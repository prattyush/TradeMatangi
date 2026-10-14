import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SwingSubscribe, SwingStreamEvent } from '../../shared/swingStream'
import { TradingStreamDrain, TradingStreamLifecycle } from './tradingStream'
const lifecycle = new TradingStreamLifecycle()

/** Reuse the native authenticated SSE reader; renderer wakes are local IPC. */
export function nativeSwingSubscribe(baseUrl: string, screenId: string): SwingSubscribe {
  return (path, onEvent, onError) => {
    const key = `swing:${screenId}:${path}`
    let stopped = false
    let unlisten: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const drain = new TradingStreamDrain(async () => {
      const snapshot = await invoke<{ latest_payload: SwingStreamEvent; events_dropped: boolean }>('desktop_stream_snapshot', { key })
      if (stopped) return
      if (snapshot.events_dropped) onEvent({ type: 'portfolio_refresh_required' })
      const payload = snapshot.latest_payload
      if (payload?.type === 'batch') for (const event of payload.events) onEvent(event)
      else if (payload) onEvent(payload)
    }, onError)
    const start = async () => {
      try {
        await lifecycle.run(key, async () => {
          if (stopped) return
          if (!unlisten) unlisten = await listen<{ key: string }>('desktop-swing-events-available', event => {
            if (!stopped && event.payload.key === key) void drain.wake()
          })
          if (stopped) { unlisten?.(); return }
          await invoke('start_desktop_stream', { baseUrl, key, eventsPath: `swing/portfolios/${path}`, snapshotPath: `swing/portfolios/${path.replace(/\/events$/, '')}` })
          if (!stopped) await drain.wake()
        })
      } catch (error) {
        if (!stopped) { onError(error); retry = setTimeout(start, 5000) }
      }
    }
    void start()
    return () => {
      stopped = true
      drain.stop()
      unlisten?.()
      if (retry !== undefined) clearTimeout(retry)
      void lifecycle.run(key, async () => { await invoke('stop_desktop_stream', { key }) }).catch(onError)
    }
  }
}

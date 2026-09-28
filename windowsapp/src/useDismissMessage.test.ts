import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleMessageDismiss, shouldShowMessage } from './useDismissMessage'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('desktop notification timing', () => {
  it('dismisses success after five seconds and errors after ten', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    let success = 'Saved'
    let error = 'Save failed'
    scheduleMessageDismiss(success, update => { success = typeof update === 'function' ? update(success) : update }, 5_000)
    scheduleMessageDismiss(error, update => { error = typeof update === 'function' ? update(error) : update }, 10_000)
    vi.advanceTimersByTime(4_999)
    expect(success).toBe('Saved')
    expect(error).toBe('Save failed')
    vi.advanceTimersByTime(1)
    expect(success).toBe('')
    vi.advanceTimersByTime(5_000)
    expect(error).toBe('')
  })

  it('keeps a newer error when an older timer expires', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    let message = 'First failure'
    const setMessage = (update: string | ((current: string) => string)) => { message = typeof update === 'function' ? update(message) : update }
    scheduleMessageDismiss(message, setMessage, 10_000)
    vi.advanceTimersByTime(2_000)
    message = 'Second failure'
    scheduleMessageDismiss(message, setMessage, 10_000)
    vi.advanceTimersByTime(8_000)
    expect(message).toBe('Second failure')
    vi.advanceTimersByTime(2_000)
    expect(message).toBe('')
  })

  it('does not re-show the same polling error until recovery resets its identity', () => {
    let lastMessage = ''
    const message = 'Live update unavailable'
    expect(shouldShowMessage(lastMessage, message)).toBe(true)
    lastMessage = message
    expect(shouldShowMessage(lastMessage, message)).toBe(false)
    lastMessage = ''
    expect(shouldShowMessage(lastMessage, message)).toBe(true)
  })
})

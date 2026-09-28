import { useEffect, type Dispatch, type SetStateAction } from 'react'

export const shouldShowMessage = (lastMessage: string, nextMessage: string): boolean => nextMessage !== lastMessage

export function scheduleMessageDismiss(
  message: string,
  setMessage: Dispatch<SetStateAction<string>>,
  durationMs: number,
): () => void {
  const timer = window.setTimeout(() => setMessage(current => current === message ? '' : current), durationMs)
  return () => window.clearTimeout(timer)
}

/** Dismiss visible feedback without changing the operation or retry state behind it. */
export function useDismissMessage(
  message: string,
  setMessage: Dispatch<SetStateAction<string>>,
  durationMs: number,
): void {
  useEffect(() => {
    if (!message) return
    return scheduleMessageDismiss(message, setMessage, durationMs)
  }, [message, setMessage, durationMs])
}

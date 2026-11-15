import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type Show = (message: string) => void
const ToastContext = createContext<Show>(() => {})

/** `const toast = useToast(); toast('Saved')` shows a short message at the bottom for about two seconds. */
export const useToast = (): Show => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback<Show>(text => {
    setMessage(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(null), 2000)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {message && <div className="toast" role="status" aria-live="polite">{message}</div>}
    </ToastContext.Provider>
  )
}

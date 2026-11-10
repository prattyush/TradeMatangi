import type { ReactNode } from 'react'

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state" role="status">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <strong>{message}</strong>
      {onRetry && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
    </div>
  )
}

/** A feature this server does not have (older branch) or this account may not use. Never a crash. */
export function NotAvailable({ what }: { what: string }) {
  return (
    <EmptyState title={`${what} is not available on this server`}>
      The server you are connected to does not offer it yet. Switch to a newer server in More, or try again later.
    </EmptyState>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner" role="status" aria-label={label} />
}

/** What went wrong with a request, in terms a screen can act on. */
export type ApiErrorKind =
  | 'network' // no connection / DNS / TLS failure; the session is still valid
  | 'timeout' // the server did not answer in time
  | 'auth' // signed out: no usable token and it could not be refreshed
  | 'http' // the server answered with an error status
  | 'config' // the app itself is misconfigured (for example a non-https server URL)

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  /** FastAPI `detail`, when the server sent one. Never contains a token. */
  readonly detail?: string

  constructor(kind: ApiErrorKind, message: string, options: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = options.status
    this.detail = options.detail
  }
}

/** A route the server does not have at all (an older branch), as opposed to "that record does not exist". */
export const isMissingEndpoint = (error: unknown): boolean =>
  error instanceof ApiError && error.kind === 'http' && error.status === 404 && (error.detail ?? '').trim().toLowerCase() === 'not found'

/** The server knows the route but this account may not use it (for example real-trading data). */
export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.kind === 'http' && error.status === 403

/** A feature a screen cannot show on this server: missing route or no permission. */
export const isNotAvailable = (error: unknown): boolean => isMissingEndpoint(error) || isForbidden(error)

export const isOffline = (error: unknown): boolean =>
  error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout')

/** Short text for a banner or an inline error. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return 'No connection to the server. Check your network and try again.'
    if (error.kind === 'timeout') return 'The server took too long to answer. Try again.'
    if (error.kind === 'auth') return 'You have been signed out. Sign in again.'
    if (isMissingEndpoint(error)) return 'This feature is not available on this server.'
    if (isForbidden(error)) return 'Your account does not have access to this.'
    if (error.kind === 'config') return error.message
    return error.detail || `The server returned an error (${error.status ?? 'unknown'}).`
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

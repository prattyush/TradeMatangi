import { readableError } from '../../analysis/behavior/types'

export const UNSUPPORTED_SERVER = 'This server does not have this feature yet. Update the backend, then try again.'
export const UNREACHABLE_SERVER = 'Could not reach the server. Check the connection and try again.'

/**
 * An error as the user should read it. The server's own sentences ("Deep dive not found", "The selected date is not a trading
 * day") pass through unchanged; what a bare transport error means is said plainly: a route the server does not have (an
 * older backend answers 404 "Not Found") and a connection that did not get through.
 */
export function friendlyError(error: unknown): string {
  const text = readableError(error).trim()
  if (/^not found$/i.test(text) || /request failed[^]*\b404\b/i.test(text)) return UNSUPPORTED_SERVER
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(text)) return UNREACHABLE_SERVER
  return text
}

import { ApiError, describeError } from '../../api/errors'

/** The server may have acted although no answer came back: the order may exist. */
export function isUncertainWrite(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && (error.status === 502 || error.status === 504))
}

/** Plain words for a failed swing action. Money is involved: say what is known and what is not. */
export function describeSwingError(error: unknown): string {
  if (!(error instanceof ApiError)) return describeError(error)
  const detail = error.detail?.trim()
  if (error.kind === 'network' || error.kind === 'timeout')
    return 'No answer from the server. The request may have gone through: refresh and look before doing anything else. Sending the same order again is safe, it cannot be placed twice.'
  if (error.kind !== 'http') return describeError(error)
  switch (error.status) {
    case 402: return `Not enough funds. ${detail ?? ''}`.trim()
    case 403: return detail ?? 'The portfolio does not allow this now (entries paused, loss limit reached, or no access).'
    case 404: return 'That portfolio or order no longer exists. Refresh.'
    case 409:
      if (detail && /restor/i.test(detail)) return 'The server is still restoring the portfolio. Try again in a moment.'
      return `${detail ?? 'The portfolio changed.'} Refresh and try again.`
    case 502: return 'The broker did not confirm. The order may or may not be placed: refresh and check before doing anything else. Sending the same order again is safe, it cannot be placed twice.'
    case 504: return 'The server did not answer in time. The order may or may not be placed: refresh and check. Sending the same order again is safe.'
    default: return describeError(error)
  }
}

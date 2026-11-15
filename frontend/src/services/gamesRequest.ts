import { BACKEND_URL } from '../config'
import { _authHeaders } from './api'
import { GamesHttpError, type GamesRequest } from '../../../shared/games/core/client'
import { validGamesPath } from '../../../shared/games/core/paths'

/** Website transport for `/api/desktop/v1/games/*` (the desktop uses a Rust command instead). Same contract as `GamesRequest`. */
export const websiteGamesRequest: GamesRequest = async <T,>(path: string, method: 'GET' | 'PUT', body?: unknown, signal?: AbortSignal) => {
  if (!validGamesPath(path, method)) throw new Error('Invalid games request')
  const response = await fetch(`${BACKEND_URL}/api/desktop/v1/games/${path}`, {
    method,
    headers: { ...(body === undefined || body === null ? {} : { 'Content-Type': 'application/json' }), ..._authHeaders() },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new GamesHttpError(response.status, typeof data?.detail === 'string' ? data.detail : `Games request failed (${response.status})`, data)
  return data as T
}

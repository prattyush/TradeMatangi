import { parseNativeError, type GamesMethod, type GamesRequest } from '../../shared/games/core/client'
import { validGamesPath } from '../../shared/games/core/paths'

export { validGamesPath }

type Native = (command: string, args: Record<string, unknown>) => Promise<unknown>

/** Requests go through the native command (the bearer is held by the Rust host). `native` is injectable for tests. */
export function gamesRequest(baseUrl: string, native: Native): GamesRequest {
  return async <T,>(path: string, method: GamesMethod, body: unknown = null, signal?: AbortSignal) => {
    if (!validGamesPath(path, method)) throw new Error('Invalid games request')
    if (signal?.aborted) throw new DOMException('Games request cancelled', 'AbortError')
    const call = (native('desktop_games_request', { baseUrl, path, method, body }) as Promise<T>).catch(error => { throw parseNativeError(error) })
    if (!signal) return call
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Games request cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}

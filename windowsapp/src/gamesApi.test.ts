import { describe, expect, it, vi } from 'vitest'
import { gamesRequest, validGamesPath } from './gamesApi'
import { GamesHttpError } from '../../shared/games/core/client'

/** The same allow/deny cases run in the Rust test `games_allowlist_is_exact_and_method_scoped` (src-tauri/src/lib.rs). */
const OK: Array<[string, string]> = [['GET', 'state'], ['PUT', 'state'], ['GET', 'availability'], ['GET', 'window?symbol=NIFTY&date=2026-10-01&start_sec=34200&duration_sec=300'], ['GET', 'state?x=1']]
const BAD: Array<[string, string]> = [
  ['POST', 'state'], ['DELETE', 'state'], ['PUT', 'availability'], ['PUT', 'window'], ['GET', ''], ['GET', '/state'], ['GET', 'state/'],
  ['GET', 'state/x'], ['GET', 'states'], ['GET', '../analysis/sessions'], ['GET', 'state/../x'], ['GET', 'st%61te'], ['GET', 'state#x'],
  ['GET', 'state\\x'], ['GET', './state'], ['GET', 'trades'], ['GET', 'orders'], ['PATCH', 'state'], ['get', 'state'],
  ['GET', 'availability/x'], ['GET', 'window/x'], ['GET', '?state'],
]

describe('games transport allowlist', () => {
  it.each(OK)('allows %s %s', (method, path) => expect(validGamesPath(path, method)).toBe(true))
  it.each(BAD)('rejects %s %s', (method, path) => expect(validGamesPath(path, method)).toBe(false))
})

describe('gamesRequest (desktop)', () => {
  it('calls the native command with base url, path, method and body', async () => {
    const native = vi.fn().mockResolvedValue({ version: 1 })
    const request = gamesRequest('http://localhost:8700', native)
    expect(await request('state', 'PUT', { a: 1 })).toEqual({ version: 1 })
    expect(native).toHaveBeenCalledWith('desktop_games_request', { baseUrl: 'http://localhost:8700', path: 'state', method: 'PUT', body: { a: 1 } })
  })
  it('refuses paths outside the allowlist without calling the host', async () => {
    const native = vi.fn()
    await expect(gamesRequest('http://x', native)('orders', 'GET' as never)).rejects.toThrow('Invalid games request')
    await expect(gamesRequest('http://x', native)('state', 'POST' as never)).rejects.toThrow('Invalid games request')
    expect(native).not.toHaveBeenCalled()
  })
  it('maps a host failure to GamesHttpError with the status', async () => {
    const native = vi.fn().mockRejectedValue('Games request failed (409 Conflict): {"detail":"changed","current":{}}')
    const error = await gamesRequest('http://x', native)('state', 'PUT', {}).catch(e => e)
    expect(error).toBeInstanceOf(GamesHttpError); expect(error.status).toBe(409)
  })
  it('does not call the host for an already cancelled request, and stops waiting when cancelled', async () => {
    const native = vi.fn().mockReturnValue(new Promise(() => undefined))
    const aborted = new AbortController(); aborted.abort()
    await expect(gamesRequest('http://x', native)('state', 'GET', null, aborted.signal)).rejects.toThrow('cancelled')
    expect(native).not.toHaveBeenCalled()
    const later = new AbortController()
    const pending = gamesRequest('http://x', native)('state', 'GET', null, later.signal)
    later.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })
})

/** Typed access to `/api/desktop/v1/games/*`. The transport is injected: Rust command on the desktop, `fetch` on the website. */
import type { ProgressState, PutBody } from './progress'

export type GamesMethod = 'GET' | 'PUT'
export type GamesRequest = <T>(path: string, method: GamesMethod, body?: unknown, signal?: AbortSignal) => Promise<T>

/** An HTTP failure with its status, so callers can tell a 409 conflict from a 422 or an outage. */
export class GamesHttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message)
    this.name = 'GamesHttpError'
  }
}

/** The desktop host reports failures as `Games request failed (409 Conflict): {json}`; turn that back into a status. */
export function parseNativeError(error: unknown): unknown {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
  const match = /^Games request failed \((\d{3})[^)]*\):\s*([\s\S]*)$/.exec(text)
  if (!match) return error
  let body: unknown = match[2]
  try { body = JSON.parse(match[2]) } catch { /* keep text */ }
  const detail = typeof body === 'object' && body !== null && 'detail' in body ? String((body as { detail: unknown }).detail) : match[2]
  return new GamesHttpError(Number(match[1]), detail || `Games request failed (${match[1]})`, body)
}

export interface PutResult { version: number; applied: boolean; records: Record<string, unknown> }
export interface ConflictBody { detail?: string; current?: Record<string, unknown> }

export interface GamesClient {
  getState(signal?: AbortSignal): Promise<ProgressState>
  putState(body: PutBody, signal?: AbortSignal): Promise<PutResult>
}

export function createGamesClient(request: GamesRequest): GamesClient {
  return {
    async getState(signal) {
      const state = await request<Partial<ProgressState>>('state', 'GET', undefined, signal)
      return { version: 1, profile: null, games: {}, days: {}, months: {}, ...state }
    },
    putState: (body, signal) => request<PutResult>('state', 'PUT', body, signal),
  }
}

export const isConflict = (error: unknown): boolean => error instanceof GamesHttpError && error.status === 409
export const isRejected = (error: unknown): boolean => error instanceof GamesHttpError && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429 && error.status !== 401 && error.status !== 403 && error.status !== 404

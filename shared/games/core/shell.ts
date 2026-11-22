/**
 * The session flow shared by every game (spec 4.2, 17.3): instructions, Practice/Progress choice, 3-2-1 countdown,
 * play, result. Pure state machine; `ui/GameShell.tsx` renders it.
 *
 *  - A timed block cannot be paused; a round-based market game can be paused between rounds.
 *  - Esc asks to quit; quitting a Progress session records nothing.
 *  - A void (focus lost too long, data failed) records nothing either.
 */
import type { SessionMode, SessionSummary } from './types'

export type ShellPhase = 'instructions' | 'countdown' | 'playing' | 'paused' | 'result' | 'closed' | 'voided'

export interface ShellState {
  phase: ShellPhase
  mode: SessionMode
  level: number
  timed: boolean
  countdown: number
  /** Set while the quit confirmation is open; remembers where to return. */
  quitFrom: ShellPhase | null
  summary: SessionSummary | null
  voidReason: string | null
}

export type ShellEvent =
  | { type: 'start'; mode: SessionMode; level: number }
  | { type: 'tick' }
  | { type: 'finish'; summary: SessionSummary }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'requestQuit' }
  | { type: 'cancelQuit' }
  | { type: 'confirmQuit' }
  | { type: 'void'; reason: string }
  | { type: 'again' }

export const COUNTDOWN_FROM = 3

export const initialShell = (timed: boolean, level = 1): ShellState => ({
  phase: 'instructions', mode: 'progress', level, timed, countdown: COUNTDOWN_FROM, quitFrom: null, summary: null, voidReason: null,
})

export function shellReducer(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case 'start':
      if (state.phase !== 'instructions') return state
      return { ...state, phase: 'countdown', mode: event.mode, level: event.level, countdown: COUNTDOWN_FROM }
    case 'tick':
      if (state.phase !== 'countdown' || state.quitFrom) return state
      return state.countdown <= 1 ? { ...state, phase: 'playing', countdown: 0 } : { ...state, countdown: state.countdown - 1 }
    case 'finish':
      if (state.phase !== 'playing' && !(state.phase === 'paused')) return state
      return { ...state, phase: 'result', summary: event.summary, quitFrom: null }
    case 'pause':
      return state.phase === 'playing' && !state.timed ? { ...state, phase: 'paused' } : state
    case 'resume':
      return state.phase === 'paused' ? { ...state, phase: 'playing' } : state
    case 'requestQuit':
      return state.phase === 'countdown' || state.phase === 'playing' || state.phase === 'paused' ? { ...state, quitFrom: state.phase } : state
    case 'cancelQuit':
      return state.quitFrom ? { ...state, quitFrom: null } : state
    case 'confirmQuit':
      return state.quitFrom ? { ...state, phase: 'closed', quitFrom: null } : state
    case 'void':
      return state.phase === 'countdown' || state.phase === 'playing' || state.phase === 'paused'
        ? { ...state, phase: 'voided', voidReason: event.reason, quitFrom: null } : state
    case 'again':
      return state.phase === 'result' || state.phase === 'voided' ? initialShell(state.timed, state.level) : state
    default:
      return state
  }
}

/** Only a finished session counts. Progress updates level and stats; Practice only bumps the practice counter. */
export const shouldRecord = (state: ShellState): boolean => state.phase === 'result' && state.summary !== null

/** The clock of a timed block stops being allowed to run while the window is unfocused for more than this. */
export const FOCUS_LOSS_LIMIT_MS = 10_000

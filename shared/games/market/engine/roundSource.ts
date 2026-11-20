/**
 * Hands out rounds for a market game one at a time (spec 4.3): picks a window, fetches it, builds the round and, when the round is
 * not the kind the level wants (edge or no edge, choppiness), tries up to `maxCandidates` windows and keeps the best fit. A window
 * that is not cached or too thin is replaced; `maxFailures` in a row end the session gracefully. The game's own code (`build`) says
 * what a usable round is, so this stays generic for the other market games.
 */
import type { Rng } from '../../core/rng'
import { TICK_READER } from '../config/difficulty.market'
import { pickWindow, type Availability, type PickRules, type WindowPick } from './windows'
import type { WindowData } from './series'

export interface WindowFetcher {
  window(query: { symbol: string; date: string; startSec: number; durationSec: number }, signal?: AbortSignal): Promise<WindowData>
}

export interface RoundPlan<Round> {
  rules: PickRules
  /** Seconds to fetch before and after the decision point. */
  fetchBefore: number
  fetchAfter: number
  build(window: WindowData, pick: WindowPick): Round | null
  /** Lower is a better fit to what the level wants. */
  misfit(round: Round, wantNoEdge: boolean): number
  wantNoEdge(rng: Rng): boolean
}

export type NextRound<Round> = { ok: true; round: Round } | { ok: false; reason: 'no_data' | 'cancelled' }

export interface RoundSource<Round> { next(signal?: AbortSignal): Promise<NextRound<Round>> }

export function createRoundSource<Round>(deps: {
  rng: Rng
  availability: Availability
  fetcher: WindowFetcher
  plan: RoundPlan<Round>
  /** Ids played in the last N days (local memory). */
  seen: ReadonlySet<string>
  /** Called with the id of the window that was handed out, so the memory is updated. */
  onUsed?: (id: string) => void
  maxCandidates?: number
  maxFailures?: number
  /** A candidate with a misfit below this is accepted without fetching more. */
  goodEnough?: number
}): RoundSource<Round> {
  const used = new Set<string>()
  const maxCandidates = deps.maxCandidates ?? TICK_READER.maxCandidates
  const maxFailures = deps.maxFailures ?? TICK_READER.maxFailures
  const { plan } = deps
  return {
    async next(signal) {
      const wantNoEdge = plan.wantNoEdge(deps.rng)
      let best: { round: Round; id: string; misfit: number } | null = null
      let failures = 0
      let tried = 0
      while (tried < maxCandidates && failures < maxFailures) {
        if (signal?.aborted) return { ok: false, reason: 'cancelled' }
        const pick = pickWindow(deps.rng, deps.availability, plan.rules, deps.seen, used)
        if (!pick) { failures += 1; break }
        used.add(pick.id)
        try {
          const window = await deps.fetcher.window({ symbol: pick.symbol, date: pick.date, startSec: pick.decisionSec - plan.fetchBefore, durationSec: plan.fetchBefore + plan.fetchAfter }, signal)
          const round = plan.build(window, pick)
          if (!round) { failures += 1; continue }
          tried += 1
          failures = 0
          const misfit = plan.misfit(round, wantNoEdge)
          if (!best || misfit < best.misfit) best = { round, id: pick.id, misfit }
          if (misfit < (deps.goodEnough ?? 0.15)) break
        } catch (error) {
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return { ok: false, reason: 'cancelled' }
          failures += 1
        }
      }
      if (best) { deps.onUsed?.(best.id); return { ok: true, round: best.round } }
      return { ok: false, reason: 'no_data' }
    },
  }
}

import { useMemo, useState, type ReactNode } from 'react'
import { catalogueEntry, CATEGORY_LABEL, type GameId } from '../core/ids'
import { registeredIds } from '../core/registry'
import { buildWarmup, type WarmupPlan, type WarmupStep } from '../core/warmup'
import { warmupCount, warmupStreak, WARMUP_MIN_FOR_STREAK, WARMUP_STEPS } from '../core/dashboard'
import type { ProgressState } from '../core/progress'
import type { GamesSettings } from '../core/settings'

export interface RenderGameOptions { stepLabel?: string; onSkip?: () => void; onExit: () => void; warmupStep?: number; onFinished?: () => void }
interface Props {
  state: ProgressState
  settings: GamesSettings
  userId: string
  today: string
  /** Renders a game inside the shared shell; the hub supplies it so recording and settings stay in one place. */
  renderGame: (id: GameId, options: RenderGameOptions) => ReactNode
}

type StepState = 'done' | 'skipped'
const storageKey = (userId: string, date: string) => `tm-games-warmup:${userId}:${date}`
function loadSteps(userId: string, date: string): Record<number, StepState> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey(userId, date)) ?? '{}') as Record<string, unknown>
    const out: Record<number, StepState> = {}
    for (const [key, value] of Object.entries(raw)) if (value === 'done' || value === 'skipped') out[Number(key)] = value
    return out
  } catch { return {} }
}
function saveSteps(userId: string, date: string, steps: Record<number, StepState>): void {
  try { window.localStorage.setItem(storageKey(userId, date), JSON.stringify(steps)) } catch { /* private mode: the routine just forgets where it was */ }
}

const planKey = (userId: string, date: string, pool: string) => `tm-games-warmplan:${userId}:${date}:${pool}`
function loadPlan(userId: string, date: string, pool: string): WarmupPlan | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(planKey(userId, date, pool)) ?? 'null') as WarmupPlan | null
    const playable = new Set(registeredIds())
    if (!raw || !Array.isArray(raw.steps) || !raw.steps.length || !raw.steps.every(step => typeof step?.index === 'number' && playable.has(step.gameId))) return null
    return raw
  } catch { return null }
}
function savePlan(userId: string, date: string, pool: string, plan: WarmupPlan): void {
  try { window.localStorage.setItem(planKey(userId, date, pool), JSON.stringify(plan)) } catch { /* the plan is simply rebuilt next time */ }
}

export function Warmup({ state, settings, userId, today, renderGame }: Props) {
  const plan = useMemo(() => {
    // The plan is built once a day per pool setting and kept on this device, so playing a step (which changes the ratings the plan
    // came from) or reopening the tab never reshuffles it.
    const saved = loadPlan(userId, today, settings.warmupPool)
    if (saved) return saved
    const built = buildWarmup({ userId, date: today, pool: settings.warmupPool, playable: registeredIds(), state })
    if (userId !== 'unknown') savePlan(userId, today, settings.warmupPool, built)
    return built
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, today, settings.warmupPool])
  const [steps, setSteps] = useState<Record<number, StepState>>(() => loadSteps(userId, today))
  const [running, setRunning] = useState<WarmupStep | null>(null)
  const streak = warmupStreak(state.days, today)
  const doneCount = Object.values(steps).filter(value => value === 'done').length
  const settle = (index: number, value: StepState) => setSteps(current => { const next = { ...current, [index]: value }; saveSteps(userId, today, next); return next })

  if (running) {
    return (
      <>{renderGame(running.gameId, {
        stepLabel: `Warm-up step ${running.index} of ${plan.steps.length}`,
        warmupStep: steps[running.index] === 'done' ? undefined : running.index,
        onFinished: () => settle(running.index, 'done'),
        onSkip: () => { if (steps[running.index] !== 'done') settle(running.index, 'skipped'); setRunning(null) },
        onExit: () => setRunning(null),
      })}</>
    )
  }

  const settled = plan.steps.filter(step => steps[step.index]).length
  const next = plan.steps.find(step => !steps[step.index])
  const kept = Math.max(doneCount, warmupCount(state.days[today])) >= WARMUP_MIN_FOR_STREAK
  return (
    <section aria-labelledby="games-warm-title">
      <h3 id="games-warm-title">Daily Warm-up</h3>
      <p>A short routine for before the market opens, about ten minutes. The same plan all day: it comes from your date, your ratings and the games you have played lately.</p>
      {plan.notice && <p className="games-banner" role="status">{plan.notice}</p>}
      <p className="games-streak" role="status">Streak: <strong>{streak.current} day{streak.current === 1 ? '' : 's'}</strong> (best {streak.best}). Finish at least {WARMUP_MIN_FOR_STREAK} of {WARMUP_STEPS} steps to keep it.</p>
      <ol className="games-warm-steps">
        {plan.steps.map(step => {
          const entry = catalogueEntry(step.gameId)
          const status = steps[step.index]
          return (
            <li key={step.index} data-state={status ?? (next?.index === step.index ? 'next' : 'todo')}>
              <div>
                <strong>{entry.title}</strong> <span className="games-meta">{CATEGORY_LABEL[entry.category]} · {step.reason}</span>
              </div>
              <div className="games-row">
                <span aria-label={status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : 'to do'}>{status === 'done' ? '✓ done' : status === 'skipped' ? 'skipped' : ''}</span>
                <button onClick={() => setRunning(step)}>{status === 'done' ? 'Play again' : status === 'skipped' ? 'Play now' : 'Play'}</button>
              </div>
            </li>
          )
        })}
      </ol>
      {settled < plan.steps.length && next && <div className="games-row"><button className="games-primary" onClick={() => setRunning(next)}>{settled === 0 ? 'Start the warm-up' : 'Continue'}</button></div>}
      {settled === plan.steps.length && (
        <p role="status">{kept ? `Warm-up done: ${doneCount} of ${plan.steps.length} steps. Your streak is kept.` : `Warm-up finished with ${doneCount} of ${plan.steps.length} steps. ${WARMUP_MIN_FOR_STREAK} are needed to keep the streak.`}</p>
      )}
      <p className="games-meta">Warm-up games are normal sessions: they count in your progress like any other. Choose Practice in a game if you do not want that.</p>
    </section>
  )
}

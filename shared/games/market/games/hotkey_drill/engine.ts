/**
 * Hotkey Drill (spec 5.5): clean, fast execution on a mock order panel. Pure and seeded; every time is passed in by the caller
 * (the View reads the frame clock), so this file never touches a clock. Nothing here can place an order: the panel is a few
 * numbers in memory (spec 3.4 rule 4).
 *
 * The panel: digits 1 to 5 or the arrows set the lots, a letter key stages an action (buy CE, buy PE, exit all, stop to cost) and
 * Enter confirms it. A prompt is done when the confirmed action (and, for a buy, the lots) is the one asked for. Anything else is a
 * fat-finger: it is logged and the prompt stays.
 */
import type { Rng } from '../../../core/rng'
import { toSessionScore, clamp } from '../../../core/scoring'
import type { SessionSummary } from '../../../core/types'
import { HOTKEY_DRILL } from '../../config/difficulty.market'
import { DEFAULT_KEYS, type KeyMap } from '../../engine/hotkeys'

export type Action = 'buy_ce' | 'buy_pe' | 'exit_all' | 'stop_cost'
export interface Step { action: Action; /** Buys only. */ lots?: number }
export interface Prompt { id: number; steps: Step[]; ignore: boolean; text: string }

export type ErrorType = 'wrong_key' | 'nothing_staged' | 'wrong_action' | 'wrong_side' | 'wrong_lots' | 'ignored_cue' | 'missed'
export const ERROR_TYPES: readonly ErrorType[] = ['wrong_key', 'nothing_staged', 'wrong_action', 'wrong_side', 'wrong_lots', 'ignored_cue', 'missed']

export interface Panel { lots: number; staged: Action | null }
export const FRESH_PANEL: Panel = { lots: 1, staged: null }
export const MAX_LOTS = 5

export interface PromptParams { maxChain: number; ignoreShare: number; lotsMax: number }

const ACTION_TEXT: Record<Action, string> = { buy_ce: 'BUY CE', buy_pe: 'BUY PE', exit_all: 'EXIT ALL', stop_cost: 'STOP TO COST' }
export const describeStep = (step: Step): string => (step.lots !== undefined ? `${ACTION_TEXT[step.action]} ${step.lots} lot${step.lots > 1 ? 's' : ''}` : ACTION_TEXT[step.action])
export const describePrompt = (steps: Step[]): string => steps.map(describeStep).join(' → ')

const ACTIONS: readonly Action[] = ['buy_ce', 'buy_pe', 'exit_all', 'stop_cost']

export function makePrompt(rng: Rng, id: number, params: PromptParams): Prompt {
  if (params.ignoreShare > 0 && rng.chance(params.ignoreShare)) return { id, steps: [], ignore: true, text: 'IGNORE: do nothing' }
  const length = rng.int(1, Math.max(1, Math.round(params.maxChain)))
  const steps: Step[] = []
  for (let i = 0; i < length; i++) {
    let action = rng.pick(ACTIONS)
    while (i > 0 && action === steps[i - 1].action) action = rng.pick(ACTIONS)
    steps.push(action === 'buy_ce' || action === 'buy_pe' ? { action, lots: rng.int(1, Math.min(MAX_LOTS, Math.max(1, params.lotsMax))) } : { action })
  }
  return { id, steps, ignore: false, text: describePrompt(steps) }
}

export interface KeyInput { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }

/** A key that is part of the panel's vocabulary or a plain printable key; modifiers, Tab, Escape and function keys are not the drill's business. */
export function isDrillKey(input: KeyInput): boolean {
  if (input.ctrlKey || input.altKey || input.metaKey) return false
  return input.key.length === 1 || input.key === 'ArrowUp' || input.key === 'ArrowDown' || input.key === 'Enter'
}

export type Press =
  | { kind: 'ignored_key' }
  | { kind: 'lots'; lots: number }
  | { kind: 'staged'; action: Action }
  | { kind: 'error'; error: ErrorType }
  | { kind: 'step_done'; stepIndex: number }
  | { kind: 'prompt_done'; rtMs: number }
  | { kind: 'ignored_cue_error' }

export interface PromptResult {
  id: number
  steps: number
  kind: 'done' | 'ignored' | 'missed'
  /** Onset to the last confirm, for a done prompt. */
  rtMs: number
  errors: ErrorType[]
}

export interface Drill {
  readonly panel: Panel
  readonly current: Prompt | null
  readonly stepIndex: number
  /** Errors made on the prompt that is still open (they join the log when it finishes). */
  readonly openErrors: number
  start(prompt: Prompt, nowMs: number): void
  press(input: KeyInput, nowMs: number): Press
  /** The prompt's time ran out. */
  expire(): void
  /** The ignore cue ended without a key press: the right answer. */
  settleIgnore(): void
  /** The block ended with a prompt still open: it is dropped, not scored. */
  abandon(): void
  results(): PromptResult[]
}

export function createDrill(keys: KeyMap = DEFAULT_KEYS): Drill {
  const keyAction: Record<string, Action> = { [keys.buyCe]: 'buy_ce', [keys.buyPe]: 'buy_pe', [keys.exitAll]: 'exit_all', [keys.stopCost]: 'stop_cost' }
  let panel: Panel = { ...FRESH_PANEL }
  let prompt: Prompt | null = null
  let onset = 0
  let stepIndex = 0
  let errors: ErrorType[] = []
  const log: PromptResult[] = []

  const finish = (kind: PromptResult['kind'], rtMs = 0) => {
    if (!prompt) return
    log.push({ id: prompt.id, steps: Math.max(1, prompt.steps.length), kind, rtMs, errors })
    prompt = null; errors = []
  }
  const fail = (error: ErrorType): Press => { errors.push(error); return { kind: 'error', error } }

  return {
    get panel() { return panel },
    get current() { return prompt },
    get stepIndex() { return stepIndex },
    get openErrors() { return errors.length },
    start(next, nowMs) { prompt = next; onset = nowMs; stepIndex = 0; errors = []; panel = { ...FRESH_PANEL } },
    press(input, nowMs) {
      if (!prompt || !isDrillKey(input)) return { kind: 'ignored_key' }
      if (prompt.ignore) { errors.push('ignored_cue'); finish('ignored'); return { kind: 'ignored_cue_error' } }
      const { key } = input
      if (key === 'Enter') {
        const step = prompt.steps[stepIndex]
        if (!panel.staged) return fail('nothing_staged')
        if (panel.staged !== step.action) return fail((panel.staged === 'buy_ce' || panel.staged === 'buy_pe') && (step.action === 'buy_ce' || step.action === 'buy_pe') ? 'wrong_side' : 'wrong_action')
        if (step.lots !== undefined && panel.lots !== step.lots) return fail('wrong_lots')
        panel = { ...FRESH_PANEL }
        stepIndex += 1
        if (stepIndex >= prompt.steps.length) {
          const rtMs = Math.max(0, nowMs - onset)
          finish('done', rtMs)
          return { kind: 'prompt_done', rtMs }
        }
        return { kind: 'step_done', stepIndex: stepIndex - 1 }
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') { panel = { ...panel, lots: clamp(panel.lots + (key === 'ArrowUp' ? 1 : -1), 1, MAX_LOTS) }; return { kind: 'lots', lots: panel.lots } }
      if (/^[1-5]$/.test(key)) { panel = { ...panel, lots: Number(key) }; return { kind: 'lots', lots: panel.lots } }
      const action = keyAction[key.toLowerCase()]
      if (action) { panel = { ...panel, staged: action }; return { kind: 'staged', action } }
      return fail('wrong_key')
    },
    expire() { if (prompt && !prompt.ignore) { errors.push('missed'); finish('missed') } },
    settleIgnore() { if (prompt?.ignore) finish('ignored') },
    abandon() { prompt = null; errors = [] },
    results: () => log.slice(),
  }
}

const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/**
 * `accuracy = correct / (correct + errors)`; `speedFactor = clamp((RT_slow - medianRT) / (RT_slow - RT_fast), 0, 1)` with the
 * reaction time of a chain divided by its length; `SessionScore = 100 x accuracy x (0.4 + 0.6 x speedFactor)`, capped at 60 when more
 * than 15 % of the answers were errors. A correct ignore counts as correct but has no reaction time.
 */
export function summariseHotkeyDrill(results: PromptResult[], rtSlowMs: number, _level?: number): SessionSummary {
  const correct = results.filter(r => r.kind !== 'missed' && !r.errors.includes('ignored_cue')).length
  const errorList = results.flatMap(r => r.errors)
  const errors = errorList.length
  const done = results.filter(r => r.kind === 'done')
  const rts = done.map(r => r.rtMs / r.steps)
  const med = median(rts)
  const accuracy = correct + errors > 0 ? correct / (correct + errors) : 0
  const speed = rts.length ? clamp((rtSlowMs - med) / Math.max(1, rtSlowMs - HOTKEY_DRILL.rtFastMs), 0, 1) : 0
  const errorRate = correct + errors > 0 ? errors / (correct + errors) : 0
  let score = 100 * accuracy * (0.4 + 0.6 * speed)
  if (errorRate > HOTKEY_DRILL.errorCapRate) score = Math.min(score, HOTKEY_DRILL.errorCapScore)
  let streak = 0, longest = 0
  for (const r of results) { if (r.kind !== 'missed' && r.errors.length === 0) { streak += 1; longest = Math.max(longest, streak) } else streak = 0 }
  const stats: Record<string, number> = {
    prompts: results.length, correct, errors, error_rate: Math.round(errorRate * 1000) / 10,
    median_rt_ms: Math.round(med), p90_rt_ms: Math.round(percentile(rts, 0.9)), longest_streak: longest,
  }
  for (const type of ERROR_TYPES) stats[`err_${type}`] = errorList.filter(e => e === type).length
  return { score: toSessionScore(score), stats }
}

import type { PatternAnnotation } from '../../../shared/analysis/api'
import type { FineDefinition, FineFlow, FineQueryStep, FlowStep, StructureCandle } from '../patternsClient'

export type Pane = 'underlying' | 'CE' | 'PE'
export const STEP_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787']
export const stepColor = (index: number) => STEP_COLORS[index % STEP_COLORS.length]

export const parseSubTypes = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean)

export const stepLabel = (step: Pick<FlowStep, 'name' | 'type'>) => step.name + (step.type ? `(${step.type})` : '')

export function newStep(definition: Pick<FineDefinition, 'definition_id' | 'name'>, type: string, direction: string): FlowStep {
  return { definition_id: definition.definition_id, name: definition.name, type: type || undefined, direction: direction || undefined }
}

/** Remove a step; returns the new active index (the active step moves up if one before it went). */
export function removeStep(steps: FlowStep[], index: number, active: number | null): { steps: FlowStep[]; active: number | null } {
  const next = steps.filter((_, i) => i !== index)
  if (active === index) return { steps: next, active: null }
  return { steps: next, active: active !== null && active > index ? active - 1 : active }
}

/** Swap a step with its neighbour; the active selection follows the step it was on. */
export function moveStep(steps: FlowStep[], index: number, direction: -1 | 1, active: number | null): { steps: FlowStep[]; active: number | null } {
  const target = index + direction
  if (target < 0 || target >= steps.length) return { steps, active }
  const next = [...steps]
  ;[next[index], next[target]] = [next[target], next[index]]
  return { steps: next, active: active === index ? target : active === target ? index : active }
}

export const setTransition = (steps: FlowStep[], index: number, time: number): FlowStep[] =>
  steps.map((s, i) => (i === index ? { ...s, transition_bar_time: time } : s))

/** "Clear" with no drawing left: drop the transition of the last step that has one. */
export function clearLastTransition(steps: FlowStep[]): FlowStep[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].transition_bar_time) return steps.map((s, j) => (j === i ? { ...s, transition_bar_time: undefined } : s))
  }
  return steps
}

/** The candle holding a transition time at the chart's interval. */
export function candleAt(candles: StructureCandle[], time: number, intervalMinutes: number): StructureCandle | undefined {
  const bucket = Math.floor(time / (intervalMinutes * 60)) * (intervalMinutes * 60)
  return candles.find(c => c.time === bucket)
}

/**
 * Transition bars as chart marks. Bull points up under the bar, Bear points down over it (the chart's entry / exit
 * arrows); the mark's category carries the step number because the chart cuts marker text to a few characters.
 */
export function stepAnnotations(steps: FlowStep[], pane: Pane, candles: StructureCandle[], intervalMinutes: number): PatternAnnotation[] {
  const marks: PatternAnnotation[] = []
  steps.forEach((step, index) => {
    if (!step.transition_bar_time) return
    const bar = candleAt(candles, step.transition_bar_time, intervalMinutes)
    const bear = step.direction === 'Bear'
    const price = bar ? (bear ? bar.high : bar.low) : undefined
    if (price === undefined) return
    marks.push({ id: `step-${pane}-${index}`, time: step.transition_bar_time, price, type: bear ? 'exit' : 'entry', instrument: pane, strategy_name: stepLabel(step), category: String(index + 1), text: stepLabel(step) })
  })
  return marks
}

/** The saved flow for one pane: options flows are told apart by right (underlying has none). */
export function findFlow(flows: FineFlow[], instrumentType: 'equity' | 'options', pane: Pane): FineFlow | null {
  const right = pane === 'underlying' ? null : pane
  const matches = flows.filter(f => (f.instrument_type || 'equity') === instrumentType && (f.right ?? null) === right)
  return matches.find(f => f.can_delete) ?? matches[0] ?? null
}

export const flowStepsToSave = (steps: FlowStep[]): FlowStep[] => steps.map(s => ({ ...s }))

/** Search query step: "*" is a wildcard that matches any one step, without a type or direction. */
export function queryStep(definition: Pick<FineDefinition, 'name'> | null, wildcard: boolean, type: string, direction: string): FineQueryStep | null {
  if (wildcard) return { name: '*' }
  if (!definition) return null
  return { name: definition.name, type: type || undefined, direction: direction || undefined }
}

export const isMatchStep = (index: number, matchStart: number, queryLength: number) => index >= matchStart && index < matchStart + queryLength

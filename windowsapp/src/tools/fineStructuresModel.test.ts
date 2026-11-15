import { describe, expect, it, vi } from 'vitest'
import type { FineFlow, FlowStep, StructureCandle } from '../patternsClient'
import { createPatternsClient } from '../patternsClient'
import { candleAt, clearLastTransition, findFlow, isMatchStep, moveStep, newStep, parseSubTypes, queryStep, removeStep, setTransition, stepAnnotations, stepLabel } from './fineStructuresModel'

const step = (name: string, extra: Partial<FlowStep> = {}): FlowStep => ({ definition_id: name, name, ...extra })
const bar = (time: number, low: number, high: number): StructureCandle => ({ time, open: low, high, low, close: high })
const flow = (extra: Partial<FineFlow>): FineFlow => ({ flow_id: 'f', symbol: 'NIFTY', date: '2026-10-02', steps: [], instrument_type: 'equity', right: null, interval_minutes: 3, user_id: 'u', can_delete: true, created_at: '', updated_at: '', ...extra })

describe('fine structures model', () => {
  it('splits sub-types on commas and drops blanks', () => {
    expect(parseSubTypes(' a, b ,, c ')).toEqual(['a', 'b', 'c'])
  })
  it('builds a step from a definition, leaving empty type and direction unset', () => {
    expect(newStep({ definition_id: 'd', name: 'Breakout' }, '', 'Bull')).toEqual({ definition_id: 'd', name: 'Breakout', type: undefined, direction: 'Bull' })
    expect(stepLabel({ name: 'Breakout', type: 'Strong' })).toBe('Breakout(Strong)')
  })
  it('keeps the active step on the same step when one before it is removed', () => {
    const steps = [step('a'), step('b'), step('c')]
    expect(removeStep(steps, 0, 2)).toEqual({ steps: [steps[1], steps[2]], active: 1 })
    expect(removeStep(steps, 2, 2).active).toBeNull()
    expect(removeStep(steps, 2, 0).active).toBe(0)
  })
  it('moves a step and its selection together, and ignores moves off either end', () => {
    const steps = [step('a'), step('b'), step('c')]
    expect(moveStep(steps, 1, -1, 1)).toEqual({ steps: [steps[1], steps[0], steps[2]], active: 0 })
    expect(moveStep(steps, 0, -1, null).steps).toBe(steps)
    expect(moveStep(steps, 0, 1, 1).active).toBe(0)
  })
  it('sets and clears transitions; clearing takes the last step that has one', () => {
    const steps = setTransition(setTransition([step('a'), step('b'), step('c')], 0, 100), 1, 200)
    expect(clearLastTransition(steps).map(s => s.transition_bar_time)).toEqual([100, undefined, undefined])
    expect(clearLastTransition([step('a')])).toHaveLength(1)
  })
  it('finds the candle holding a time at the chart interval', () => {
    const candles = [bar(180, 1, 2), bar(360, 3, 4)]
    expect(candleAt(candles, 400, 3)?.low).toBe(3)
    expect(candleAt(candles, 100, 3)).toBeUndefined()
  })
  it('marks Bull below the bar and Bear above it, numbered, skipping steps without a bar or a candle', () => {
    const candles = [bar(180, 10, 20), bar(360, 30, 40)]
    const steps = [step('Break', { direction: 'Bull', transition_bar_time: 190, type: 'Strong' }), step('Fade', { direction: 'Bear', transition_bar_time: 370 }), step('None'), step('Gone', { transition_bar_time: 99999 })]
    const marks = stepAnnotations(steps, 'CE', candles, 3)
    expect(marks.map(m => [m.type, m.price, m.category, m.instrument, m.strategy_name])).toEqual([['entry', 10, '1', 'CE', 'Break(Strong)'], ['exit', 40, '2', 'CE', 'Fade']])
  })
  it('picks the right flow per pane and prefers the user\'s own', () => {
    const flows = [flow({ flow_id: 'eq' }), flow({ flow_id: 'ul', instrument_type: 'options' }), flow({ flow_id: 'ce', instrument_type: 'options', right: 'CE' }),
      flow({ flow_id: 'shared-pe', instrument_type: 'options', right: 'PE', can_delete: false }), flow({ flow_id: 'own-pe', instrument_type: 'options', right: 'PE' })]
    expect(findFlow(flows, 'equity', 'underlying')?.flow_id).toBe('eq')
    expect(findFlow(flows, 'options', 'underlying')?.flow_id).toBe('ul')
    expect(findFlow(flows, 'options', 'CE')?.flow_id).toBe('ce')
    expect(findFlow(flows, 'options', 'PE')?.flow_id).toBe('own-pe')
    expect(findFlow([], 'equity', 'underlying')).toBeNull()
  })
  it('builds search steps, with a bare wildcard', () => {
    expect(queryStep(null, true, 'x', 'Bull')).toEqual({ name: '*' })
    expect(queryStep({ name: 'Breakout' }, false, '', 'Bear')).toEqual({ name: 'Breakout', type: undefined, direction: 'Bear' })
    expect(queryStep(null, false, '', '')).toBeNull()
    expect(isMatchStep(2, 1, 2)).toBe(true)
    expect(isMatchStep(3, 1, 2)).toBe(false)
  })
})

describe('fine structures client', () => {
  it('unwraps lists and sends the saved interval with a flow update', async () => {
    const request = vi.fn().mockResolvedValueOnce({ definitions: [{ name: 'a' }] }).mockResolvedValueOnce({ results: [{ match_start_index: 1 }] }).mockResolvedValue({})
    const client = createPatternsClient(request)
    expect(await client.listDefinitions()).toEqual([{ name: 'a' }])
    expect(await client.searchFlows({ query_steps: [{ name: '*' }] })).toEqual([{ match_start_index: 1 }])
    await client.updateFlow('f1', [], 5)
    expect(request).toHaveBeenLastCalledWith('fine-structures/flow/f1', 'PUT', { steps: [], interval_minutes: 5 })
  })
  it('looks flows up by day, instrument type and right', async () => {
    const request = vi.fn().mockResolvedValue({ flows: [] })
    await createPatternsClient(request).listFlows({ symbol: 'NIFTY', start_date: '2026-10-02', end_date: '2026-10-02', instrument_type: 'options', right: 'CE' })
    expect(request).toHaveBeenCalledWith('fine-structures/flows?symbol=NIFTY&start_date=2026-10-02&end_date=2026-10-02&instrument_type=options&right=CE', 'GET')
  })
  it('asks for option candles by strike and right', async () => {
    const request = vi.fn().mockResolvedValue({ candles: [] })
    await createPatternsClient(request).fineOptionsOhlc('NIFTY', '2026-10-02', 24000, 'PE', 3, 2)
    expect(request).toHaveBeenCalledWith('fine-structures/ohlc-options/NIFTY/2026-10-02?strike=24000&right=PE&interval_minutes=3&days_back=2', 'GET')
  })
})

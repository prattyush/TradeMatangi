import { describe, expect, it } from 'vitest'
import { shouldConsumeDrawingCommand } from './drawingState'

describe('drawing command consumption', () => {
  const command = { id: 4, tool: 'Trend' }

  it('consumes the matching command in once mode', () => {
    expect(shouldConsumeDrawingCommand('once', command, 4, 'Trend')).toBe(true)
  })

  it('does not consume a stale command after switching charts', () => {
    expect(shouldConsumeDrawingCommand('once', null, 4, 'Trend')).toBe(false)
  })

  it('does not consume a command from another tool or selection', () => {
    expect(shouldConsumeDrawingCommand('once', command, 3, 'Trend')).toBe(false)
    expect(shouldConsumeDrawingCommand('once', command, 4, 'Horizontal')).toBe(false)
  })

  it('keeps repeat mode armed', () => {
    expect(shouldConsumeDrawingCommand('repeat', command, 4, 'Trend')).toBe(false)
  })
})

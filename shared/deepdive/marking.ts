import type { PatternAnnotation } from '../analysis/api'

/** The mark tools of the Pattern Library and the Deep Dive: entry and exit on the underlying and on the CE and PE charts. */
export const TOOL_OPTIONS = [
  { key: 'entry-underlying', label: '▲ Entry UL', type: 'entry', instrument: 'underlying' },
  { key: 'exit-underlying', label: '▼ Exit UL', type: 'exit', instrument: 'underlying' },
  { key: 'entry-CE', label: '▲ Entry CE', type: 'entry', instrument: 'CE' },
  { key: 'exit-CE', label: '▼ Exit CE', type: 'exit', instrument: 'CE' },
  { key: 'entry-PE', label: '▲ Entry PE', type: 'entry', instrument: 'PE' },
  { key: 'exit-PE', label: '▼ Exit PE', type: 'exit', instrument: 'PE' },
] as const
export type ToolOption = (typeof TOOL_OPTIONS)[number]

/**
 * Click on a pane with a tool: a second click with the same tool, bar, strategy and category removes the mark
 * (the website's behaviour), otherwise it is added.
 */
export function toggleAnnotation(
  annotations: PatternAnnotation[], tool: ToolOption, time: number, price: number, strategy: string, category: string, id: string,
): PatternAnnotation[] {
  const duplicate = annotations.find(a => a.time === time && a.instrument === tool.instrument && a.strategy_name === strategy && a.category === category && a.type === tool.type)
  if (duplicate) return annotations.filter(a => a.id !== duplicate.id)
  return [...annotations, { id, time, price, type: tool.type, instrument: tool.instrument, strategy_name: strategy, category, text: `${category} — ${strategy} (${tool.type} ${tool.instrument})` }]
}

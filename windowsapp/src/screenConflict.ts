export interface ScreenStateRecord {
  [key: string]: unknown
}

const PRESENTATION_FIELDS = ['layout', 'tiles', 'indicators', 'activeToolTileId', 'speed']
const LIFECYCLE_FIELDS = ['mode', 'live_enabled', 'live_stream_id', 'session_id', 'run_id', 'owned', 'run_date', 'start_time']

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergePresentationField(field: string, base: unknown, local: unknown, remote: unknown, preferLocalConflicts = false): { value: unknown; conflict?: string } {
  const localChanged = !equal(local, base)
  const remoteChanged = !equal(remote, base)
  if (localChanged && remoteChanged && !equal(local, remote)) return preferLocalConflicts ? { value: local } : { value: remote, conflict: field }
  if (localChanged) return { value: local }
  return { value: remote }
}

function mergeIndicators(base: unknown, local: unknown, remote: unknown, preferLocalConflicts: boolean): { value: unknown; conflict?: string } {
  if (!base || !local || !remote || typeof base !== 'object' || typeof local !== 'object' || typeof remote !== 'object' || Array.isArray(base) || Array.isArray(local) || Array.isArray(remote)) {
    return mergePresentationField('indicators', base, local, remote, preferLocalConflicts)
  }
  const result: Record<string, unknown> = { ...(remote as Record<string, unknown>) }
  const keys = new Set([...Object.keys(base as Record<string, unknown>), ...Object.keys(local as Record<string, unknown>), ...Object.keys(remote as Record<string, unknown>)])
  for (const key of keys) {
    const merged = mergePresentationField(`indicators.${key}`, (base as Record<string, unknown>)[key], (local as Record<string, unknown>)[key], (remote as Record<string, unknown>)[key], preferLocalConflicts)
    if (merged.conflict) return { value: remote, conflict: merged.conflict }
    if (merged.value === undefined) delete result[key]
    else result[key] = merged.value
  }
  return { value: result }
}

function mergeTiles(base: unknown, local: unknown, remote: unknown, preferLocalConflicts: boolean): { value: unknown; conflict?: string } {
  if (!Array.isArray(base) || !Array.isArray(local) || !Array.isArray(remote)) return mergePresentationField('tiles', base, local, remote, preferLocalConflicts)
  const byId = (value: unknown[]) => new Map(value.filter(item => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string').map(item => [(item as { id: string }).id, item]))
  const baseById = byId(base)
  const localById = byId(local)
  const remoteById = byId(remote)
  const common = [...baseById.keys()].filter(id => localById.has(id) && remoteById.has(id))
  const commonSet = new Set(common)
  const baseOrder = common
  const localOrder = [...localById.keys()].filter(id => commonSet.has(id))
  const remoteOrder = [...remoteById.keys()].filter(id => commonSet.has(id))
  const localReordered = !equal(localOrder, baseOrder)
  const remoteReordered = !equal(remoteOrder, baseOrder)
  if (localReordered && remoteReordered && !equal(localOrder, remoteOrder) && !preferLocalConflicts) {
    return { value: remote, conflict: 'tiles.order' }
  }
  const preferredOrder = localReordered ? [...localById.keys()] : [...remoteById.keys()]
  const ids = [...new Set([...preferredOrder, ...remoteById.keys(), ...localById.keys()])]
  const result: unknown[] = []
  for (const id of ids) {
    const merged = mergePresentationField(`tiles.${id}`, baseById.get(id), localById.get(id), remoteById.get(id), preferLocalConflicts)
    if (merged.conflict) return { value: remote, conflict: merged.conflict }
    if (merged.value !== undefined) result.push(merged.value)
  }
  return { value: result }
}

export interface ScreenMergeResult {
  state: ScreenStateRecord
  conflicts: string[]
}

/** Merge a stale full-screen snapshot without ever merging Paper/Replay ownership silently. */
export function mergeScreenState(base: ScreenStateRecord, local: ScreenStateRecord, remote: ScreenStateRecord, preferLocalConflicts = false): ScreenMergeResult {
  const state: ScreenStateRecord = { ...remote }
  const conflicts: string[] = []
  const fields = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])

  for (const field of fields) {
    const baseValue = base[field]
    const localValue = local[field]
    const remoteValue = remote[field]
    const localChanged = !equal(localValue, baseValue)
    const remoteChanged = !equal(remoteValue, baseValue)

    if (LIFECYCLE_FIELDS.includes(field)) {
      // A remote lifecycle change may point at a different engine/run. Require
      // reconciliation even when this client did not change that field.
      if (remoteChanged && !equal(localValue, remoteValue)) {
        if (preferLocalConflicts && localChanged) state[field] = localValue
        else conflicts.push(field)
      }
      else if (localChanged && !remoteChanged) state[field] = localValue
      continue
    }

    if (field === 'indicators') {
      const merged = mergeIndicators(baseValue, localValue, remoteValue, preferLocalConflicts)
      state[field] = merged.value
      if (merged.conflict) conflicts.push(merged.conflict)
      continue
    }

    if (field === 'tiles') {
      const merged = mergeTiles(baseValue, localValue, remoteValue, preferLocalConflicts)
      state[field] = merged.value
      if (merged.conflict) conflicts.push(merged.conflict)
      continue
    }

    if (PRESENTATION_FIELDS.includes(field)) {
      const merged = mergePresentationField(field, baseValue, localValue, remoteValue, preferLocalConflicts)
      state[field] = merged.value
      if (merged.conflict) conflicts.push(merged.conflict)
      continue
    }

    // Unknown fields are treated conservatively until their ownership is explicit.
    if (localChanged && remoteChanged && !equal(localValue, remoteValue)) {
      if (preferLocalConflicts) state[field] = localValue
      else conflicts.push(field)
    }
    else if (localChanged) state[field] = localValue
  }

  return { state, conflicts }
}

export interface ScreenDraft {
  state: ScreenStateRecord
  name: string
  order: number
}

export function mergeScreenDraft(base: ScreenDraft, local: ScreenDraft, remote: ScreenDraft, preferLocalConflicts = false): { draft: ScreenDraft; conflicts: string[] } {
  const state = mergeScreenState(base.state, local.state, remote.state, preferLocalConflicts)
  const name = mergePresentationField('name', base.name, local.name, remote.name, preferLocalConflicts)
  const order = mergePresentationField('order', base.order, local.order, remote.order, preferLocalConflicts)
  return {
    draft: { state: state.state, name: name.value as string, order: order.value as number },
    conflicts: [...state.conflicts, ...(name.conflict ? [name.conflict] : []), ...(order.conflict ? [order.conflict] : [])],
  }
}

/** The key map of the Hotkey Drill (spec 5.5). The desktop has no trading hotkey store to copy (plan #9), so these are the game's own. */
export interface KeyMap { buyCe: string; buyPe: string; exitAll: string; stopCost: string }

export const DEFAULT_KEYS: KeyMap = { buyCe: 'c', buyPe: 'p', exitAll: 'x', stopCost: 's' }
export type KeyName = keyof KeyMap
export const KEY_NAMES: readonly KeyName[] = ['buyCe', 'buyPe', 'exitAll', 'stopCost']

const letter = (value: unknown): string | null => (typeof value === 'string' && /^[a-zA-Z]$/.test(value) ? value.toLowerCase() : null)

/** Four different single letters; a missing, invalid or repeated one falls back to its default (and a default already taken moves to the first free letter). */
export function normalizeKeys(raw: unknown): KeyMap {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: Partial<KeyMap> = {}
  const taken = new Set<string>()
  for (const name of KEY_NAMES) {
    const wanted = letter(input[name])
    if (wanted && !taken.has(wanted)) { out[name] = wanted; taken.add(wanted) }
  }
  for (const name of KEY_NAMES) {
    if (out[name]) continue
    let candidate = DEFAULT_KEYS[name]
    if (taken.has(candidate)) candidate = 'abcdefghijklmnopqrstuvwxyz'.split('').find(l => !taken.has(l))!
    out[name] = candidate; taken.add(candidate)
  }
  return out as KeyMap
}

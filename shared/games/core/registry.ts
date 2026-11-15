/** Registry of playable games. Adding a game = one folder plus one `registerGame` line in `games/index.ts` (spec 4.1). */
import { catalogueEntry, isGameId, type GameId } from './ids'
import type { AnyGameDefinition } from './types'

const registry = new Map<GameId, AnyGameDefinition>()

export function registerGame(definition: AnyGameDefinition): void {
  if (!isGameId(definition.id)) throw new Error(`Unknown game id ${String(definition.id)}`)
  if (registry.has(definition.id)) throw new Error(`Game ${definition.id} is already registered`)
  const entry = catalogueEntry(definition.id)
  const expectedKind = entry.pool === 'market' ? 'market' : 'trial'
  if (definition.kind !== expectedKind) throw new Error(`Game ${definition.id} must be of kind ${expectedKind}`)
  if (definition.category !== entry.category) throw new Error(`Game ${definition.id} must be in category ${entry.category}`)
  if (definition.instructions.length > 6) throw new Error(`Game ${definition.id} has more than 6 instruction lines`)
  registry.set(definition.id, definition)
}

export const getGame = (id: GameId): AnyGameDefinition | undefined => registry.get(id)
export const isPlayable = (id: GameId): boolean => registry.has(id)
export const registeredIds = (): GameId[] => [...registry.keys()]
/** Tests only. */
export const clearRegistryForTests = (): void => registry.clear()

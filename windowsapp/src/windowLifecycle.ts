export const SAVE_TIMEOUT_MS = 4500

export async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

export interface RecoveryJournal<T> { state: T; revision?: number; mutationId: string }
export function journalKey(server: string, screenId: string): string {
  return `desktop-screen-recovery:${server.replace(/\/$/, '')}:${screenId}`
}
export function recoverState<T>(saved: T, revision: number, journal: RecoveryJournal<T> | null): T {
  // A different revision may belong to another window's newer save. Keep the
  // journal available for inspection rather than overwriting authoritative state.
  return journal && journal.revision === revision ? journal.state : saved
}

export function controlledScreens<T extends { id: string; persistedId?: string }>(screens: T[], assignedId: string | null, loaded: boolean, external: string[]): T[] {
  if (assignedId) return loaded ? screens.filter(screen => screen.id === assignedId || screen.persistedId === assignedId) : []
  return screens.filter(screen => !external.includes(screen.id))
}

export async function closeAfterSave(save: Promise<unknown>, close: () => Promise<unknown>, onError: (error: unknown) => void): Promise<void> {
  try { await bounded(save, SAVE_TIMEOUT_MS) }
  catch (error) { onError(error) }
  finally { await close() }
}

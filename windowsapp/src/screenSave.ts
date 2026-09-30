import { mergeScreenDraft, type ScreenDraft } from './screenConflict'

export interface SavedScreenRecord extends ScreenDraft {
  screen_id: string
  revision: number
}

export interface ScreenSaveTransport<T extends SavedScreenRecord> {
  write: (id: string | undefined, revision: number | undefined, draft: ScreenDraft, mutationId: string) => Promise<T>
  read: (id: string) => Promise<T>
  isConflict: (error: unknown) => boolean
}

/** Sample the base and draft inside execute, after earlier screen saves settle. */
export function enqueueScreenSave<T>(previous: Promise<unknown>, execute: () => Promise<T>): Promise<T> {
  return previous.catch(() => undefined).then(execute)
}

/** Does not mutate the caller's base. It becomes authoritative only on success. */
export async function saveScreenRecord<T extends SavedScreenRecord>(base: T | null, submitted: ScreenDraft, mutationId: string, transport: ScreenSaveTransport<T>): Promise<T> {
  try {
    return await transport.write(base?.screen_id, base?.revision, submitted, mutationId)
  } catch (error) {
    if (!base || !transport.isConflict(error)) throw error
    const remote = await transport.read(base.screen_id)
    const merged = mergeScreenDraft(base, submitted, remote)
    if (merged.conflicts.length) throw new Error(`Screen changed remotely in protected fields: ${merged.conflicts.join(', ')}; reload and reconcile`)
    return transport.write(remote.screen_id, remote.revision, merged.draft, crypto.randomUUID())
  }
}

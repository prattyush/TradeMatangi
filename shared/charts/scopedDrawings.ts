import { canonicalDrawingKey, drawingIdentity } from "./drawingIdentity";
import type { DrawingRequest } from "./klineDrawingModel";

/**
 * Drawings of one day's Notes chart (Phase 27, S8). They live in their own namespace, the contract's instrument plus a `drawing_scope`
 * (the mechanism Swing already uses), so what is drawn, changed or deleted there never touches the drawings of the other charts.
 * The first time a day's Notes chart of a contract is opened, the drawings the other charts have saved for the contract are copied into
 * the scope once (`seedScopedDrawings`); a hidden marker record says it was done, so a drawing deleted in Notes is not copied again.
 */
export const NOTES_SEED_TOOL = "NotesSeed";
export const notesScope = (date: string) => `notes:${date}`;

type ScopedRequest = DrawingRequest;
interface Record_ {
  drawing_id: string;
  revision: number;
  drawing: { tool?: string; [key: string]: unknown };
}

export const isSeedRecord = (record: Record_) => record?.drawing?.tool === NOTES_SEED_TOOL;

/** The scoped identity of a contract (where the Notes chart writes and reads) and the plain one the other charts use (what is copied from). */
export function scopedIdentity(instrument: Record<string, unknown>, scope: string) {
  const own = drawingIdentity(instrument, scope, undefined, true);
  // Only the scope itself is read: the alias keys of `drawingIdentity` are the other charts' unscoped records.
  const scopedKey = canonicalDrawingKey(own.writeInstrument);
  return {
    writeInstrument: own.writeInstrument,
    readKeys: [scopedKey],
    scopedKey,
    sourceKeys: drawingIdentity(instrument, undefined, undefined, true).readKeys,
  };
}

const list = async (request: ScopedRequest, key: string): Promise<Record_[]> =>
  ((await request(`drawings?instrument=${encodeURIComponent(key)}`, "GET")) as { drawings?: Record_[] } | null)?.drawings ?? [];
const unique = (records: Record_[]) => [...new Map(records.map((record) => [record.drawing_id, record])).values()];
const sameDrawing = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const seeding = new Map<string, Promise<boolean>>();

/**
 * Copy the other charts' drawings of the contract into the Notes scope, once. Safe to call again (it does nothing once the marker is
 * there), safe when two charts ask at the same moment (one runs), and safe to retry after a failure half way (a drawing already copied
 * is not copied twice). Resolves true when it copied.
 */
export function seedScopedDrawings(request: ScopedRequest, identity: ReturnType<typeof scopedIdentity>): Promise<boolean> {
  const running = seeding.get(identity.scopedKey);
  if (running) return running;
  const work = (async () => {
    const own = await list(request, identity.scopedKey);
    if (own.some(isSeedRecord)) return false;
    const sources = unique((await Promise.all(identity.sourceKeys.map((key) => list(request, key)))).flat());
    for (const source of sources) {
      if (own.some((record) => sameDrawing(record.drawing, source.drawing))) continue;
      await request("drawings", "POST", { instrument: identity.writeInstrument, drawing: source.drawing, mutation_id: crypto.randomUUID() });
    }
    await request("drawings", "POST", {
      instrument: identity.writeInstrument,
      drawing: { tool: NOTES_SEED_TOOL, points: [{ timestamp: 0, price: 0 }] },
      mutation_id: crypto.randomUUID(),
    });
    return true;
  })();
  seeding.set(identity.scopedKey, work);
  void work.then(
    () => seeding.delete(identity.scopedKey),
    () => seeding.delete(identity.scopedKey),
  );
  return work;
}

/**
 * What a Notes chart shows: the scope's own drawings (without the marker). A day whose Notes chart was never opened has none and, when
 * the chart is only being viewed (`viewOnly`, the Summary), shows the other charts' drawings instead, which is what Notes would start from.
 */
export async function loadScopedRecords(request: ScopedRequest, identity: ReturnType<typeof scopedIdentity>, viewOnly: boolean) {
  const own = await list(request, identity.scopedKey);
  if (own.some(isSeedRecord) || !viewOnly) return own.filter((record) => !isSeedRecord(record));
  return unique((await Promise.all(identity.sourceKeys.map((key) => list(request, key)))).flat());
}

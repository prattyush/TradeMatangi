/** Drawing namespaces stay compatible with Day; feed venues retain NFO/BFO. */
export const canonicalDrawingKey = (instrument: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(instrument).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );

export function drawingIdentity(
  instrument: Record<string, unknown>,
  scope?: string,
  legacyScope?: string,
  shareDayDrawings = false,
) {
  const base =
    shareDayDrawings && instrument.kind === "option"
      ? {
          ...instrument,
          exchange:
            instrument.exchange === "BFO"
              ? "BSE"
              : instrument.exchange === "NFO"
                ? "NSE"
                : instrument.exchange,
        }
      : instrument;
  const writeInstrument = scope ? { ...base, drawing_scope: scope } : base;
  const aliases = [writeInstrument];
  // Retain drawings saved by earlier Swing versions, without moving private records.
  if (
    shareDayDrawings &&
    canonicalDrawingKey(base) !== canonicalDrawingKey(instrument)
  )
    aliases.push(instrument);
  if (legacyScope) aliases.push({ ...instrument, drawing_scope: legacyScope });
  return {
    writeInstrument,
    readKeys: [...new Set(aliases.map(canonicalDrawingKey))],
  };
}

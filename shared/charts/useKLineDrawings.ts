import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Chart } from "klinecharts";
import { beginChartActivity } from "./chartActivity";
import { announceDrawingChange, watchDrawingChanges } from "./drawingEvents";
import { canonicalDrawingKey, drawingIdentity } from "./drawingIdentity";
import {
  defaultDrawingStyle,
  drawingPoints,
  overlayName,
  overlayPointsToStored,
  overlayStyles,
  toolStyle,
  type DrawingMode,
  type DrawingRecord,
  type DrawingRequest,
  type DrawingStyleSettings,
  type LocalDrawing,
  type PersistedDrawing,
} from "./klineDrawingModel";

interface Options {
  chartRef: MutableRefObject<Chart | null>;
  /** Instrument identity (see `analysisDrawingInstrument`); null disables loading/saving. */
  instrument: Record<string, unknown> | null;
  request: DrawingRequest | undefined;
  /** Keyboard shortcuts (Delete / Esc / Ctrl+Z) only act while the chart is active. */
  active?: boolean;
  onError?: (error: unknown) => void;
}

/**
 * Persisted KLine drawings for chart hosts that don't render `KLineChart`
 * (the Analysis charts). Same backend records and identity as the trading
 * charts, so a drawing made here also appears on the Day/Swing chart.
 * Mirrors the behaviour of `KLineChart.tsx` without its order/strategy state.
 */
export function useKLineDrawings({ chartRef, instrument, request, active = true, onError }: Options) {
  const [drawings, setDrawings] = useState<LocalDrawing[]>([]);
  const drawingsRef = useRef<LocalDrawing[]>([]);
  drawingsRef.current = drawings;
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setModeState] = useState<DrawingMode>("once");
  const modeRef = useRef<DrawingMode>("once");
  const [notice, setNotice] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [style, setStyle] = useState<DrawingStyleSettings>(defaultDrawingStyle);
  const styleRef = useRef(style);
  styleRef.current = style;
  const busy = useRef(0);
  const gesture = useRef(false);
  const saves = useRef(new Set<string>());
  const deletes = useRef(new Set<string>());
  const owner = useRef(crypto.randomUUID());
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const identity = useMemo(() => {
    if (!instrument) return null;
    const { writeInstrument, readKeys } = drawingIdentity(instrument, undefined, undefined, true);
    return { writeInstrument, readKeys, key: canonicalDrawingKey(writeInstrument), signature: JSON.stringify(readKeys) };
  }, [instrument && canonicalDrawingKey(instrument)]);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const setMode = useCallback((next: DrawingMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  // Drawing colours/widths come from the same per-user chart settings as the trading charts.
  useEffect(() => {
    if (!request) return;
    let live = true;
    void request("chart-settings", "GET")
      .then((data) => {
        const settings = (data as { settings?: Partial<DrawingStyleSettings> } | null)?.settings;
        if (live && settings) setStyle({ ...defaultDrawingStyle, ...settings });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [request]);

  const persist = async (path: string, method: "POST" | "PUT" | "DELETE", drawing: PersistedDrawing, revision?: number) => {
    const current = identityRef.current;
    if (!request || !current) return null;
    const end = beginChartActivity();
    busy.current++;
    try {
      const result = (await request(path, method, {
        instrument: current.writeInstrument,
        drawing,
        revision,
        mutation_id: crypto.randomUUID(),
      })) as DrawingRecord;
      if (identityRef.current?.key !== current.key) return null;
      announceDrawingChange({ owner: owner.current, keys: current.readKeys });
      return result;
    } catch (error) {
      errorRef.current?.(error);
      // Keep the local edit visible; reopening/refreshing reloads the server revision.
      return null;
    } finally {
      busy.current--;
      end();
    }
  };
  const save = async (id: string, path: string, method: "POST" | "PUT" | "DELETE", drawing: PersistedDrawing, revision?: number) => {
    if (saves.current.has(id)) {
      setNotice("This drawing is saving; try again when it finishes.");
      return null;
    }
    saves.current.add(id);
    const context = identityRef.current?.key;
    chartRef.current?.overrideOverlay({ id, lock: true });
    try {
      return await persist(path, method, drawing, revision);
    } finally {
      saves.current.delete(id);
      setNotice("");
      if (identityRef.current?.key === context) chartRef.current?.overrideOverlay({ id, lock: Boolean(drawing.locked) });
    }
  };

  const saveMoved = (event: any) => {
    gesture.current = false;
    const item = drawingsRef.current.find((row) => row.id === event.overlay.id);
    if (!item?.backendId || item.revision === undefined) return;
    const points = overlayPointsToStored(event.overlay.points);
    // A click on a drawing also ends a "move"; only save when it actually moved.
    if (JSON.stringify(points) === JSON.stringify(item.drawing.points)) return;
    const drawing = { ...item.drawing, points };
    setDrawings((items) => items.map((row) => (row.id === item.id ? { ...row, drawing, dirty: true } : row)));
    void save(item.id, `drawings/${item.backendId}`, "PUT", drawing, item.revision).then((record) => {
      if (record)
        setDrawings((items) =>
          items.map((row) => (row.id === item.id ? { ...row, drawing: record.drawing, revision: record.revision, dirty: false } : row)),
        );
    });
  };

  const handlers = {
    onPressedMoveStart: () => {
      gesture.current = true;
    },
    onPressedMoveEnd: saveMoved,
    onSelected: (event: any) => setSelected(event.overlay.id),
    onRemoved: (event: any) => setDrawings((current) => current.filter((drawing) => drawing.id !== event.overlay.id)),
  };

  const createPersistedOverlay = (record: DrawingRecord) => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay({ id: record.drawing_id });
    const id = chart.createOverlay({
      id: record.drawing_id,
      name: overlayName(record.drawing.tool),
      paneId: "candle_pane",
      points: drawingPoints(record.drawing),
      lock: Boolean(record.drawing.locked),
      visible: record.drawing.visible !== false,
      styles: overlayStyles(record.drawing.style, styleRef.current),
      ...handlers,
    } as any);
    if (typeof id !== "string") return;
    setDrawings((current) =>
      current.some((item) => item.id === id)
        ? current
        : [
            ...current,
            {
              id,
              backendId: record.drawing_id,
              revision: record.revision,
              drawing: record.drawing,
              locked: Boolean(record.drawing.locked),
              hidden: record.drawing.visible === false,
            },
          ],
    );
  };
  const createPersistedRef = useRef(createPersistedOverlay);
  createPersistedRef.current = createPersistedOverlay;

  // Load (and live-sync) persisted drawings whenever the instrument identity changes.
  useEffect(() => {
    if (!request || !identity) return;
    for (const item of drawingsRef.current) chartRef.current?.removeOverlay({ id: item.id });
    drawingsRef.current = [];
    setDrawings([]);
    setSelected(null);
    let disposed = false;
    let version = 0;
    let retry: number | undefined;
    const refresh = () => {
      if (disposed || !chartRef.current) return;
      if (busy.current || gesture.current) {
        window.clearTimeout(retry);
        retry = window.setTimeout(refresh, 250);
        return;
      }
      const mine = ++version;
      void Promise.all(
        (JSON.parse(identity.signature) as string[]).map((key) =>
          request(`drawings?instrument=${encodeURIComponent(key)}`, "GET"),
        ),
      )
        .then((values) => {
          if (disposed || mine !== version) return;
          if (busy.current || gesture.current) return refresh();
          const records = [
            ...new Map(
              values
                .flatMap((value) => (value as { drawings?: DrawingRecord[] }).drawings ?? [])
                .map((record) => [record.drawing_id, record]),
            ).values(),
          ];
          // Keep unfinished/unsaved local drawings; refresh only persisted ones.
          for (const item of drawingsRef.current) if (item.backendId && !item.dirty) chartRef.current?.removeOverlay({ id: item.id });
          setDrawings((current) => current.filter((item) => !item.backendId || item.dirty));
          const dirty = new Set(drawingsRef.current.filter((item) => item.dirty).map((item) => item.backendId));
          records.filter((record) => !dirty.has(record.drawing_id)).forEach((record) => createPersistedRef.current(record));
          setSelected(null);
        })
        .catch((error) => {
          if (!disposed && mine === version) errorRef.current?.(error);
        });
    };
    refresh();
    const stop = watchDrawingChanges(owner.current, identity.readKeys, refresh);
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      stop();
    };
  }, [identity?.signature, request]);

  const deleteDrawing = async (id: string) => {
    const drawing = drawingsRef.current.find((item) => item.id === id);
    if (!drawing || deletes.current.has(id)) return;
    if (saves.current.has(id)) {
      setNotice("This drawing is saving; try again when it finishes.");
      return;
    }
    deletes.current.add(id);
    try {
      if (drawing.backendId && drawing.revision) {
        const result = await save(id, `drawings/${drawing.backendId}`, "DELETE", drawing.drawing, drawing.revision);
        if (!result) return;
      }
      if (!drawing.drawing.points.length) gesture.current = false;
      chartRef.current?.removeOverlay({ id });
      setDrawings((current) => current.filter((item) => item.id !== id));
      setSelected((current) => (current === id ? null : current));
    } finally {
      deletes.current.delete(id);
    }
  };

  const startTool = (tool: string) => {
    const chart = chartRef.current;
    if (!chart || !identityRef.current) return;
    const look = toolStyle(tool, styleRef.current);
    const id = chart.createOverlay({
      name: overlayName(tool),
      paneId: "candle_pane",
      styles: overlayStyles(look, styleRef.current),
      ...handlers,
      onDrawStart: () => {
        gesture.current = true;
      },
      onDrawEnd: (event: any) => {
        gesture.current = false;
        const points = overlayPointsToStored(event.overlay.points);
        const drawing: PersistedDrawing = { tool, points, style: look, visible: true, locked: false };
        setDrawings((items) => items.map((item) => (item.id === event.overlay.id ? { ...item, drawing, dirty: true } : item)));
        if (points.length && typeof event.overlay.id === "string")
          void save(event.overlay.id, "drawings", "POST", drawing).then((record) => {
            if (!record) return;
            setDrawings((current) =>
              current.map((item) =>
                item.id === event.overlay.id
                  ? { ...item, backendId: record.drawing_id, revision: record.revision, drawing: record.drawing, dirty: false }
                  : item,
              ),
            );
          });
        setActiveTool(null);
        if (modeRef.current === "repeat") window.setTimeout(() => startTool(tool), 0);
      },
    } as any);
    if (typeof id !== "string") return;
    setActiveTool(tool);
    setDrawings((current) => [
      ...current,
      { id, drawing: { tool, points: [], style: look, visible: true, locked: false }, locked: false, hidden: false },
    ]);
    setSelected(id);
  };

  const updateSelected = (update: (drawing: LocalDrawing) => LocalDrawing) => {
    const drawing = drawingsRef.current.find((item) => item.id === selected);
    if (!drawing) return;
    if (saves.current.has(drawing.id)) {
      setNotice("This drawing is saving; try again when it finishes.");
      return;
    }
    const next = update(drawing);
    const persisted = { ...next.drawing, locked: next.locked, visible: !next.hidden };
    chartRef.current?.overrideOverlay({ id: next.id, lock: next.locked, visible: !next.hidden });
    setDrawings((current) => current.map((item) => (item.id === next.id ? { ...next, drawing: persisted, dirty: true } : item)));
    if (next.backendId && next.revision)
      void save(next.id, `drawings/${next.backendId}`, "PUT", persisted, next.revision).then((record) => {
        if (record)
          setDrawings((items) =>
            items.map((item) => (item.id === next.id ? { ...item, revision: record.revision, drawing: record.drawing, dirty: false } : item)),
          );
      });
  };

  const cancelTool = () => {
    // An unfinished (pointless) overlay is discarded; completed ones are untouched.
    const pending = drawingsRef.current.find((item) => !item.drawing.points.length);
    if (pending) {
      chartRef.current?.removeOverlay({ id: pending.id });
      setDrawings((current) => current.filter((item) => item.id !== pending.id));
    }
    gesture.current = false;
    setActiveTool(null);
  };

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!active || (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]"))) return;
      if (event.key === "Escape") cancelTool();
      if ((event.key === "Delete" || event.key === "Backspace") && selected !== null) {
        event.preventDefault();
        void deleteDrawing(selected);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        const last = drawingsRef.current[drawingsRef.current.length - 1];
        if (last) {
          event.preventDefault();
          void deleteDrawing(last.id);
        }
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [active, selected, drawings]);

  const selectedDrawing = drawings.find((item) => item.id === selected) ?? null;
  return {
    ready: Boolean(request && identity),
    mode,
    setMode,
    activeTool,
    startTool,
    cancelTool,
    selected: selectedDrawing,
    count: drawings.filter((item) => item.backendId).length,
    notice,
    toggleLock: () => updateSelected((item) => ({ ...item, locked: !item.locked })),
    toggleHide: () => updateSelected((item) => ({ ...item, hidden: !item.hidden })),
    deleteSelected: () => {
      if (selected) void deleteDrawing(selected);
    },
  };
}

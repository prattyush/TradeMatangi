import { useEffect, useRef, useState } from "react";
import { drawingTools, indicatorLabel } from "./catalogue";
import { analysisIndicators } from "./useKLineIndicators";
import type { useKLineDrawings } from "./useKLineDrawings";
import "./klineAnalysisTools.css";

type Drawings = ReturnType<typeof useKLineDrawings>;

const hiddenKey = "analysis-kline-tools-hidden";
const visibilityEvent = "analysis-kline-tools-visibility";
const readVisible = () => {
  try {
    return localStorage.getItem(hiddenKey) !== "1";
  } catch {
    return true;
  }
};
/** Remembered across charts and sessions; the rail is visible by default. */
export function useToolsRailVisible() {
  const [visible, setVisible] = useState(readVisible);
  useEffect(() => {
    const sync = () => setVisible(readVisible());
    window.addEventListener(visibilityEvent, sync);
    return () => window.removeEventListener(visibilityEvent, sync);
  }, []);
  const toggle = () => {
    try {
      localStorage.setItem(hiddenKey, readVisible() ? "1" : "0");
    } catch {
      /* Optional local UI preference. */
    }
    // Every Analysis chart (underlying, option, patterns) follows the same switch.
    window.dispatchEvent(new Event(visibilityEvent));
    setVisible(readVisible());
  };
  return [visible, toggle] as const;
}

/** Slim TradingView-style left rail: drawing tools, Once/Repeat, lock / hide / delete. */
export function KLineToolsRail({ drawings }: { drawings: Drawings }) {
  const { ready, activeTool, mode, selected } = drawings;
  return (
    <aside className="kline-tools-rail" aria-label="Drawing tools" data-drawing-count={drawings.count}>
      <div className="kline-tools-scroll">
        {drawingTools.map((tool) => (
          <button
            key={tool.tool}
            type="button"
            className="kline-tool"
            aria-pressed={activeTool === tool.tool}
            aria-label={tool.label}
            title={tool.label}
            disabled={!ready}
            onClick={() => (activeTool === tool.tool ? drawings.cancelTool() : drawings.startTool(tool.tool))}
          >
            {tool.icon}
          </button>
        ))}
      </div>
      <div className="kline-tools-actions">
        <button
          type="button"
          className="kline-tool"
          aria-pressed={mode === "repeat"}
          aria-label={mode === "repeat" ? "Repeat drawing: on" : "Repeat drawing: off"}
          title={mode === "repeat" ? "Keep drawing (on)" : "Keep drawing (off)"}
          onClick={() => drawings.setMode(mode === "repeat" ? "once" : "repeat")}
        >
          ⟳
        </button>
        <button type="button" className="kline-tool" disabled={!selected} aria-pressed={selected?.locked ?? false} aria-label="Lock selected drawing" title="Lock" onClick={drawings.toggleLock}>
          🔒
        </button>
        <button type="button" className="kline-tool" disabled={!selected} aria-pressed={selected?.hidden ?? false} aria-label="Hide selected drawing" title="Hide" onClick={drawings.toggleHide}>
          ◌
        </button>
        <button type="button" className="kline-tool" disabled={!selected} aria-label="Delete selected drawing" title="Delete" onClick={drawings.deleteSelected}>
          ⌫
        </button>
      </div>
      {drawings.notice && <small role="status" className="kline-tools-notice">{drawings.notice}</small>}
    </aside>
  );
}

/** "ƒx" popover listing every KLine indicator available for analysis. */
export function KLineIndicatorMenu({ names, toggle, clear }: { names: string[]; toggle: (name: string) => void; clear: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span className="kline-indicator-menu" ref={root}>
      <button type="button" aria-haspopup="true" aria-expanded={open} aria-label="Indicators" title="Indicators" onClick={() => setOpen((value) => !value)}>
        ƒx{names.length > 0 && <sup>{names.length}</sup>}
      </button>
      {open && (
        <div className="kline-indicator-popover" role="menu" aria-label="Indicators">
          <div className="kline-indicator-grid">
            {analysisIndicators.map((name) => (
              <button key={name} type="button" role="menuitemcheckbox" aria-checked={names.includes(name)} aria-pressed={names.includes(name)} onClick={() => toggle(name)}>
                {indicatorLabel(name)}
              </button>
            ))}
          </div>
          <button type="button" className="kline-indicator-clear" onClick={clear} disabled={!names.length}>
            Clear indicators
          </button>
        </div>
      )}
    </span>
  );
}

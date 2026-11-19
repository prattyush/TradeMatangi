import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Chart } from "klinecharts";
import { TEXT_MAX_LENGTH } from "./klineText-name";

export interface TextPromptState {
  /** Viewport pixels of the point being labelled. */
  x: number;
  y: number;
  initial: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/** Where (in viewport pixels) a stored point sits on a chart, for placing the prompt beside it. */
export function textPromptAnchor(chart: Chart | null, point: { timestamp: number; price: number } | undefined) {
  const dom = chart?.getDom("candle_pane", "main") ?? chart?.getDom();
  if (!chart || !dom || !point) return { x: 120, y: 120 };
  const rect = dom.getBoundingClientRect();
  const pixel = chart.convertToPixel({ timestamp: point.timestamp * 1000, value: point.price }, { paneId: "candle_pane" }) as { x?: number; y?: number };
  return { x: rect.left + (pixel?.x ?? rect.width / 2), y: rect.top + (pixel?.y ?? rect.height / 2) };
}

/**
 * A small box with a text field, placed beside the clicked point of a chart, to type (or change) the label of a Text drawing.
 * Enter or OK keeps it, Escape or Cancel drops it. It is drawn into `document.body` so no chart layout can clip or move it.
 */
export default function ChartTextPrompt({ x, y, initial, onSubmit, onCancel }: TextPromptState) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const width = 260;
  const left = Math.max(8, Math.min(x + 12, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y - 16, window.innerHeight - 70));
  return createPortal(
    <form
      role="dialog" aria-label="Chart text" className="chart-text-prompt"
      onSubmit={(event) => { event.preventDefault(); onSubmit(text.trim()); }}
      onMouseDown={(event) => event.stopPropagation()}
      style={{ position: "fixed", left, top, width, zIndex: 2000, display: "flex", gap: 6, padding: 8, background: "#161b22", border: "1px solid #30363d", borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,.45)" }}
    >
      <input
        ref={input} aria-label="Text to show on the chart" value={text} maxLength={TEXT_MAX_LENGTH} placeholder="Text on the chart"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") onCancel(); }}
        style={{ flex: 1, minWidth: 0, background: "#0d1117", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
      />
      <button type="submit" style={{ fontSize: 12 }}>OK</button>
      <button type="button" onClick={onCancel} style={{ fontSize: 12 }}>Cancel</button>
    </form>,
    document.body,
  );
}

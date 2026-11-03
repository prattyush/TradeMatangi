import { rendererAccountKey } from "./websiteChartPreferences";
/** Renderer for the Analysis and Patterns charts; independent of the trading chart renderer. */
export type AnalysisChartRenderer = "lightweight" | "kline";
export const analysisRendererEvent = "website-analysis-renderer";
export const analysisRendererCacheKey = (owner = rendererAccountKey()) =>
  `website-analysis-renderer:${owner}`;
export const normalizeAnalysisRenderer = (value: unknown): AnalysisChartRenderer =>
  value === "kline" ? "kline" : "lightweight";
export function cachedAnalysisRenderer(): AnalysisChartRenderer {
  try {
    return normalizeAnalysisRenderer(localStorage.getItem(analysisRendererCacheKey()));
  } catch {
    return "lightweight";
  }
}
/** Cache the server value for this account and tell open Analysis views to switch. */
export function publishAnalysisRenderer(value: unknown, owner: string) {
  if (rendererAccountKey() !== owner || value === undefined) return;
  const renderer = normalizeAnalysisRenderer(value);
  try {
    localStorage.setItem(analysisRendererCacheKey(owner), renderer);
  } catch {
    /* The server stays authoritative. */
  }
  window.dispatchEvent(new CustomEvent(analysisRendererEvent, { detail: { owner, renderer } }));
  return renderer;
}

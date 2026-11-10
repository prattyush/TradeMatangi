import { useEffect, useState } from "react";
import api from "../services/api";
import {
  analysisRendererEvent,
  cachedAnalysisRenderer,
  type AnalysisChartRenderer,
} from "../services/analysisRendererPreference";
import { rendererAccountKey } from "../services/websiteChartPreferences";
export type { AnalysisChartRenderer } from "../services/analysisRendererPreference";
/** Analysis & Patterns chart renderer: cached locally, the server value wins once loaded. */
export function useAnalysisChartRenderer(): AnalysisChartRenderer {
  const [renderer, setRenderer] = useState(cachedAnalysisRenderer);
  useEffect(() => {
    const owner = rendererAccountKey();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string; renderer: AnalysisChartRenderer }>).detail;
      if (detail.owner === owner) setRenderer(detail.renderer);
    };
    window.addEventListener(analysisRendererEvent, changed);
    // getUserSettings publishes website_analysis_chart_renderer, which updates this hook.
    void api.getUserSettings().catch(() => undefined);
    return () => window.removeEventListener(analysisRendererEvent, changed);
  }, []);
  return renderer;
}

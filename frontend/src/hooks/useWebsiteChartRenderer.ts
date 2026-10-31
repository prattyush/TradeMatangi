import { useEffect, useState } from "react";
import api, { type UserSettingsResponse } from "../services/api";
import {
  rendererAccountKey as accountKey,
  rendererCacheKey as cacheKey,
  type WebsiteChartRenderer,
} from "../services/websiteChartPreferences";
export type { WebsiteChartRenderer } from "../services/websiteChartPreferences";
const pending = new Map<string, Promise<UserSettingsResponse>>();
function cached(): WebsiteChartRenderer {
  try {
    return localStorage.getItem(cacheKey()) === "kline"
      ? "kline"
      : "lightweight";
  } catch {
    return "lightweight";
  }
}
export function useWebsiteChartRenderer(): WebsiteChartRenderer {
  const [renderer, setRenderer] = useState(cached);
  useEffect(() => {
    let active = true;
    const owner = accountKey();
    const apply = (settings: UserSettingsResponse) => {
      if (!active || accountKey() !== owner) return;
      const next =
        settings.website_chart_renderer === "kline" ? "kline" : "lightweight";
      setRenderer(next);
      try {
        localStorage.setItem(cacheKey(), next);
      } catch {
        /* Server remains authoritative. */
      }
    };
    const changed = (event: Event) => {
      const detail = (
        event as CustomEvent<{ owner: string; renderer: WebsiteChartRenderer }>
      ).detail;
      if (detail.owner === owner)
        apply({ website_chart_renderer: detail.renderer, historical_days: 2 });
    };
    window.addEventListener("website-chart-settings", changed);
    let request = pending.get(owner);
    if (!request) {
      request = api.getUserSettings();
      pending.set(owner, request);
      void request.finally(() => pending.delete(owner)).catch(() => undefined);
    }
    void request.then(apply).catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener("website-chart-settings", changed);
    };
  }, []);
  return renderer;
}

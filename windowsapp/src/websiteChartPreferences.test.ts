import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../frontend/src/services/api";
import {
  publishRenderer,
  rendererAccountKey,
  rendererPreferenceVersion,
} from "../../frontend/src/services/websiteChartPreferences";
let values: Map<string, string>;
beforeEach(() => {
  values = new Map([
    ["auth_user", JSON.stringify({ userId: crypto.randomUUID() })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(
        public type: string,
        public options: any,
      ) {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("website renderer preference", () => {
  it("keeps a newer saved choice when an earlier settings read completes late", () => {
    const owner = rendererAccountKey(),
      version = rendererPreferenceVersion(owner);
    publishRenderer("kline", owner);
    expect(publishRenderer("lightweight", owner, version)).toBe("kline");
    expect(values.get(`website-chart-renderer:${owner}`)).toBe("kline");
  });
  it("ignores responses from a previous authenticated account", () => {
    const owner = rendererAccountKey();
    values.set("auth_user", JSON.stringify({ userId: "different-owner" }));
    publishRenderer("kline", owner);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
  it("saves only the renderer field and rejects an old backend that silently ignores it", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ historical_days: 2 }),
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      api.updateUserSettings({ website_chart_renderer: "kline" }),
    ).rejects.toThrow(/Backend did not confirm/);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      website_chart_renderer: "kline",
    });
  });
});

it("does not trust an old backend's unbounded option response as a replay-safe partial candle", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ symbol: "NIFTY", candles: [], dates: [] }),
      }),
  );
  await expect(
    api.getOptionsHistorical(
      "NIFTY",
      "2026-10-06",
      24000,
      "2026-10-08",
      "CE",
      3,
      2,
      false,
      "replay",
      "09:25",
    ),
  ).rejects.toThrow(/replay-safe option history/);
});

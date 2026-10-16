import "./settingHelp.css";
import { useState } from "react";
import { useWebsiteChartRenderer } from "../hooks/useWebsiteChartRenderer";
import api from "../services/api";
import { flashError } from "../services/notifications";
/** Small display-settings entry for Swing, whose workspace has its own top-level controls. */
export default function ChartRendererSetting() {
  const renderer = useWebsiteChartRenderer(),
    [busy, setBusy] = useState(false);
  return (
    <details className="chart-renderer-setting">
      <summary
        title="Chart display settings"
        aria-label="Chart display settings"
      >
        ⚙
      </summary>
      <label>
        Chart renderer{" "}
        <select
          aria-label="Swing chart renderer"
          value={renderer}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.value as "lightweight" | "kline";
            setBusy(true);
            try {
              await api.updateUserSettings({ website_chart_renderer: next });
            } catch (error) {
              flashError(error, "Chart settings");
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="lightweight">Lightweight</option>
          <option value="kline">KLine</option>
        </select>
      </label>
    </details>
  );
}

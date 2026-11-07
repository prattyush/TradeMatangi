import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AnalysisProvider } from "../../../shared/analysis/environment";
import KLineAnalysisChart from "../../../shared/analysis/kline/AnalysisChart";
import AnalysisPanels from "../../../shared/analysis/kline/AnalysisPanels";
import { KLineAnalysisScope } from "../../src/components/analysis/KLineAnalysis";
import { WebsiteAnalysisChart } from "../../src/components/analysis/AnalysisCharts";

const w = window as any;
const mode = new URLSearchParams(location.search).get("mode");
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
const candles = Array.from({ length: 90 }, (_, i) => ({
  time: base + i * 180,
  open: 100 + Math.sin(i / 4) * 3,
  high: 105 + Math.sin(i / 4) * 3,
  low: 96 + Math.sin(i / 4) * 3,
  close: 101 + Math.sin(i / 4) * 3,
}));
w.drawingLog = [];
w.errors = [];
// The "backend" survives reloads so persistence can be checked end to end.
const readStore = (): any[] => JSON.parse(sessionStorage.getItem("drawing-store") ?? "[]");
const writeStore = (rows: any[]) => sessionStorage.setItem("drawing-store", JSON.stringify(rows));
const api: any = {
  getHistorical: async () => ({ candles }),
  getPreSession: async () => [],
  getOptionsHistorical: async () => ({ candles }),
  patternOhlcEquity: async () => ({ candles }),
};
const drawingRequest = async (path: string, method: string, body?: any) => {
  w.drawingLog.push({ path, method, body });
  if (path === "chart-settings") return { settings: {} };
  if (path.startsWith("drawings?")) return { version: 1, drawings: readStore() };
  if (path === "drawings" && method === "POST") {
    const row = { drawing_id: `d${readStore().length + 1}`, revision: 1, drawing: body.drawing };
    writeStore([...readStore(), row]);
    return row;
  }
  const id = path.split("/")[1];
  if (method === "PUT") {
    const row = { drawing_id: id, revision: body.revision + 1, drawing: body.drawing };
    writeStore(readStore().map((item) => (item.drawing_id === id ? row : item)));
    return row;
  }
  if (method === "DELETE") {
    writeStore(readStore().filter((item) => item.drawing_id !== id));
    return {};
  }
  throw new Error(`unexpected ${method} ${path}`);
};
const environment: any = {
  api,
  performance: {},
  drawingRequest,
  resolveSymbolInstrument: async () => ({ kind: "index", exchange: "NSE" }),
  accountKey: "test",
  reportError: (error: string) => w.errors.push(error),
  intervalMinutes: 3,
};
const optionTrades: any[] = [
  { trade_id: "t1", session_id: "s1", symbol: "NIFTY", instrument_type: "options", right: "CE", strike: 24500, expiry: "2026-10-20", side: "BUY", quantity: 50, price: 101, timestamp: base + 30 * 180, commission: 0 },
];
function App() {
  const [maximized, setMaximized] = useState(false);
  return (
    <AnalysisProvider value={environment}>
      {mode === "panels" ? (
        <KLineAnalysisScope>
          <div style={{ padding: 16 }}>
            <AnalysisPanels symbol="NIFTY" date="2026-10-16" allTrades={optionTrades} historicalDays={2} />
          </div>
        </KLineAnalysisScope>
      ) : mode === "kline" ? (
        <KLineAnalysisScope>
          <div style={{ width: 900, height: 520, position: "relative" }}>
            <KLineAnalysisChart symbol="NIFTY" date="2026-10-16" trades={[]} historicalDays={2} />
          </div>
        </KLineAnalysisScope>
      ) : (
        <div style={{ width: 900, height: maximized ? 700 : undefined }}>
          <WebsiteAnalysisChart symbol="NIFTY" date="2026-10-16" trades={[]} isMaximized={maximized} onMaximize={() => setMaximized((v) => !v)} />
        </div>
      )}
    </AnalysisProvider>
  );
}
createRoot(document.getElementById("test-root")!).render(<App />);

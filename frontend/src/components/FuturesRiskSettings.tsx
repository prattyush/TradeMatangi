import { useEffect, useState } from "react";
import api from "../services/api";
import { flashError } from "../services/notifications";

// Matches the other Admin sections in SettingsModal (dark panel, orange uppercase title, 11px labels).
const S = {
  section: { borderTop: "1px solid #21262d", paddingTop: 16 } as const,
  title: { fontSize: 12, color: "#f0883e", fontWeight: 600, marginBottom: 10 } as const,
  hint: { fontSize: 11, color: "#8b949e", margin: "0 0 12px", lineHeight: 1.5 } as const,
  error: { fontSize: 12, color: "#f85149", margin: "0 0 10px" } as const,
  checks: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 } as const,
  check: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#e6edf3", cursor: "pointer" } as const,
  details: { border: "1px solid #21262d", borderRadius: 6, padding: "8px 12px", marginBottom: 10, background: "#0d1117" } as const,
  summary: { fontSize: 12, color: "#c9d1d9", fontWeight: 600, cursor: "pointer" } as const,
  body: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10 } as const,
  wrap: { display: "flex", gap: 10, flexWrap: "wrap" } as const,
  field: { display: "grid", gap: 4, fontSize: 11, color: "#8b949e" } as const,
  input: {
    width: "100%", padding: "6px 8px", background: "#161b22", border: "1px solid #30363d",
    borderRadius: 6, color: "#e6edf3", fontSize: 12, boxSizing: "border-box",
  } as const,
  row: { fontSize: 12, color: "#c9d1d9", padding: "8px 0", borderBottom: "1px solid #21262d", display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between" } as const,
  rowMeta: { color: "#8b949e", fontSize: 11 } as const,
  actions: { display: "flex", gap: 8, alignItems: "center" } as const,
  primary: { padding: "6px 16px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer", border: "1px solid #1f6feb", background: "#1f3a5f", color: "#79c0ff" } as const,
  secondary: { padding: "6px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid #30363d", background: "#161b22", color: "#c9d1d9" } as const,
  danger: { padding: "3px 10px", fontSize: 11, borderRadius: 6, cursor: "pointer", border: "1px solid #30363d", background: "#161b22", color: "#f85149", flexShrink: 0 } as const,
};

const ACRONYMS = new Set(["stt", "sebi", "gst"]);
// "stt_rate" -> "STT rate", "effective_from" -> "Effective from"
function fieldLabel(key: string): string {
  const words = key.split("_");
  return words
    .map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export default function FuturesRiskSettings() {
  const [config, setConfig] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [broker, setBroker] = useState("kite");
  const [draft, setDraft] = useState({
    provider: "kite",
    symbol: "NIFTY",
    expiry: "",
    side: "BUY",
    quantity: "65",
    reference_price: "",
    margin: "",
    as_of: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    source: "Admin estimate",
  });
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setConfig(await api.getFuturesRisk());
    } catch (e) {
      setError(String(e));
      flashError(e, "Futures settings");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async () => {
    if (!config) return;
    setBusy(true);
    setError("");
    try {
      setConfig(await api.setFuturesRisk(config));
    } catch (e) {
      setError(String(e));
      flashError(e, "Futures settings");
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    if (!config) return;
    const row = {
      ...draft,
      quantity: Number(draft.quantity),
      reference_price: Number(draft.reference_price),
      margin: Number(draft.margin),
    };
    if (
      !row.expiry ||
      !row.as_of ||
      !Number.isInteger(row.quantity) ||
      row.quantity <= 0 ||
      !(row.reference_price > 0) ||
      !(row.margin > 0)
    ) {
      setError(
        "Enter an expiry, source date, whole quantity, reference price and margin",
      );
      return;
    }
    const estimates = (config.estimates as any[]).filter(
      (r) =>
        !(
          r.provider === row.provider &&
          r.symbol === row.symbol &&
          r.expiry === row.expiry &&
          r.side === row.side
        ),
    );
    setConfig({ ...config, estimates: [...estimates, row] });
  };
  return (
    <section style={S.section} aria-label="Futures risk settings">
      <div style={S.title}>FUTURES · MARGIN AND FEES</div>
      <p style={S.hint}>
        Offline estimates reserve a Paper intention. A fill requires a live
        contract price and usable broker margin. Real trading always rechecks
        broker funds.
      </p>
      {error && <p role="alert" style={S.error}>{error}</p>}
      {!config ? (
        <button style={S.secondary} disabled={busy} onClick={() => void load()}>
          Load Futures settings
        </button>
      ) : (
        <>
          <div style={S.checks}>
            {[
              "paper_enabled",
              "kite_real_enabled",
              "kotak_real_enabled",
              "refresh_offhours",
            ].map((key) => (
              <label key={key} style={S.check}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={Boolean(config[key])}
                  onChange={(e) =>
                    setConfig({ ...config, [key]: e.target.checked })
                  }
                />
                {
                  (
                    {
                      paper_enabled: "Paper Futures",
                      kite_real_enabled: "Kite Real Futures",
                      kotak_real_enabled: "Kotak Real Futures",
                      refresh_offhours:
                        "Refresh known estimates outside trading hours",
                    } as Record<string, string>
                  )[key]
                }
              </label>
            ))}
          </div>
          <details style={S.details}>
            <summary style={S.summary}>Broker fee profile</summary>
            <div style={S.body}>
            <select
              aria-label="Futures fee broker"
              style={{ ...S.input, width: "fit-content" }}
              value={broker}
              onChange={(e) => setBroker(e.target.value)}
            >
              <option value="kite">Kite</option>
              <option value="kotak">Kotak Neo</option>
            </select>
            <div style={S.grid}>
              {Object.keys(config.fees[broker]).map((key) => (
                <label key={key} style={S.field}>
                  {fieldLabel(key)}
                  {key.includes("rate") ? " (%)" : ""}
                  <input
                    type={key === "effective_from" ? "date" : "number"}
                    style={S.input}
                    min="0"
                    step="any"
                    disabled={busy}
                    value={
                      key.includes("rate")
                        ? Number((Number(config.fees[broker][key]) * 100).toPrecision(12))
                        : config.fees[broker][key]
                    }
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        fees: {
                          ...config.fees,
                          [broker]: {
                            ...config.fees[broker],
                            [key]:
                              key === "effective_from"
                                ? e.target.value
                                : Number(e.target.value) /
                                  (key.includes("rate") ? 100 : 1),
                          },
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            </div>
          </details>
          <details style={S.details}>
            <summary style={S.summary}>
              Offline margin observations · {config.estimates.length}
            </summary>
            <div style={S.body}>
            <div style={S.wrap}>
              {Object.entries(draft).map(([key, value]) => (
                <label key={key} style={{ ...S.field, minWidth: 120, flex: "1 1 140px" }}>
                  {fieldLabel(key)}
                  {key === "provider" || key === "side" ? (
                    <select
                      style={S.input}
                      value={value}
                      onChange={(e) =>
                        setDraft({ ...draft, [key]: e.target.value })
                      }
                    >
                      {(key === "provider"
                        ? ["kite", "kotak"]
                        : ["BUY", "SELL"]
                      ).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      style={S.input}
                      type={
                        key === "expiry" || key === "as_of"
                          ? "date"
                          : ["quantity", "reference_price", "margin"].includes(
                                key,
                              )
                            ? "number"
                            : "text"
                      }
                      value={value}
                      min="0"
                      onChange={(e) =>
                        setDraft({ ...draft, [key]: e.target.value })
                      }
                    />
                  )}
                </label>
              ))}
            </div>
            <button style={{ ...S.secondary, alignSelf: "flex-start" }} disabled={busy} onClick={add}>
              Add / replace estimate
            </button>
            <div style={{ maxHeight: 250, overflow: "auto" }}>
              {config.estimates.map((row: any, index: number) => (
                <div
                  key={`${row.provider}:${row.symbol}:${row.expiry}:${row.side}`}
                  style={S.row}
                >
                  <div>
                  {row.provider} · {row.symbol} · {row.expiry} · {row.side} ·{" "}
                  {row.quantity} units at ₹{row.reference_price} · margin ₹
                  {row.margin} · {row.as_of}
                  <br />
                  <span style={S.rowMeta}>{row.source}</span>
                  </div>
                  <button
                    style={S.danger}
                    disabled={busy}
                    onClick={() =>
                      setConfig({
                        ...config,
                        estimates: config.estimates.filter(
                          (_: any, i: number) => i !== index,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            </div>
          </details>
          <div style={S.actions}>
            <button style={S.primary} disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save Futures settings"}
            </button>
            <button style={S.secondary} disabled={busy} onClick={() => void load()}>
              Reload
            </button>
          </div>
        </>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import api from "../services/api";
import { flashError } from "../services/notifications";

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
    <section
      style={{ borderTop: "1px solid #334155", paddingTop: 16, marginTop: 16 }}
      aria-label="Futures risk settings"
    >
      <h4>Futures · margin and fees</h4>
      <p style={{ fontSize: 12 }}>
        Offline estimates reserve a Paper intention. A fill requires a live
        contract price and usable broker margin. Real trading always rechecks
        broker funds.
      </p>
      {error && <p role="alert">{error}</p>}
      {!config ? (
        <button disabled={busy} onClick={() => void load()}>
          Load Futures settings
        </button>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {[
              "paper_enabled",
              "kite_real_enabled",
              "kotak_real_enabled",
              "refresh_offhours",
            ].map((key) => (
              <label key={key}>
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
          <details>
            <summary>Broker fee profile</summary>
            <select
              aria-label="Futures fee broker"
              value={broker}
              onChange={(e) => setBroker(e.target.value)}
            >
              <option value="kite">Kite</option>
              <option value="kotak">Kotak Neo</option>
            </select>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2,minmax(0,1fr))",
                gap: 8,
              }}
            >
              {Object.keys(config.fees[broker]).map((key) => (
                <label key={key} style={{ display: "grid", gap: 3 }}>
                  {key.replace(/_/g, " ")}
                  {key.includes("rate") ? " (%)" : ""}
                  <input
                    type={key === "effective_from" ? "date" : "number"}
                    min="0"
                    step="any"
                    disabled={busy}
                    value={
                      key.includes("rate")
                        ? Number(config.fees[broker][key]) * 100
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
          </details>
          <details>
            <summary>
              Offline margin observations · {config.estimates.length}
            </summary>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(draft).map(([key, value]) => (
                <label key={key} style={{ display: "grid", gap: 3 }}>
                  {key.replace(/_/g, " ")}
                  {key === "provider" || key === "side" ? (
                    <select
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
            <button disabled={busy} onClick={add}>
              Add / replace estimate
            </button>
            <div style={{ maxHeight: 250, overflow: "auto" }}>
              {config.estimates.map((row: any, index: number) => (
                <div
                  key={`${row.provider}:${row.symbol}:${row.expiry}:${row.side}`}
                  style={{
                    fontSize: 12,
                    padding: 6,
                    borderBottom: "1px solid #334155",
                  }}
                >
                  {row.provider} · {row.symbol} · {row.expiry} · {row.side} ·{" "}
                  {row.quantity} units at ₹{row.reference_price} · margin ₹
                  {row.margin} · {row.as_of}
                  <br />
                  {row.source}
                  <button
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
          </details>
          <button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save Futures settings"}
          </button>
          <button disabled={busy} onClick={() => void load()}>
            Reload
          </button>
        </>
      )}
    </section>
  );
}

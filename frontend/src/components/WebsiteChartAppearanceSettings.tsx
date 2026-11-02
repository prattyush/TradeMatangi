import { useEffect, useState } from 'react';
import { BACKEND_URL } from '../config';
import { _authHeaders } from '../services/api';
import { rendererAccountKey } from '../services/websiteChartPreferences';

export const chartAppearanceEvent = 'website-chart-appearance';
export async function requestChartAppearance(settings?: Record<string, unknown>) {
  const response = await fetch(`${BACKEND_URL}/api/desktop/v1/chart-settings`, {
    method: settings ? 'PUT' : 'GET',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    ...(settings ? { body: JSON.stringify({ settings }) } : {}),
  });
  if (!response.ok) throw new Error(`Chart settings failed (${response.status})`);
  return (await response.json()).settings as Record<string, unknown>;
}

/** Reuses desktop's per-user chart appearance record without replacing unrelated fields. */
export default function WebsiteChartAppearanceSettings() {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const owner = rendererAccountKey();
    setDraft(null); setMessage('');
    requestChartAppearance().then(settings => {
      if (active && owner === rendererAccountKey()) setDraft(settings ?? {});
    }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, [attempt]);
  async function save() {
    if (!draft || busy) return;
    const periods = String(draft.movingAveragePeriods ?? '9,21').split(',').map(value => Number(value.trim()));
    if (!periods.length || periods.length > 6 || periods.some(value => !Number.isInteger(value) || value < 1 || value > 1000)) {
      setMessage('Enter 1–6 periods between 1 and 1000, separated by commas.'); return;
    }
    const owner = rendererAccountKey();
    setBusy(true); setMessage('');
    try {
      // Read again so editing these fields preserves other desktop appearance changes.
      const latest = await requestChartAppearance();
      if (owner !== rendererAccountKey()) return;
      const saved = await requestChartAppearance({ ...latest,
        movingAverageType: draft.movingAverageType ?? 'MA', movingAveragePeriods: periods.join(','),
        showChartInfo: draft.showChartInfo !== false,
      });
      if (owner !== rendererAccountKey()) return;
      setDraft(saved); setMessage('Chart appearance saved.');
      window.dispatchEvent(new CustomEvent(chartAppearanceEvent, { detail: { owner, settings: saved } }));
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  return <><fieldset disabled={!draft || busy} className="settings-block" style={{ border: 0, borderTop: '1px solid #21262d', margin: 0, padding: '16px 0 0', minWidth: 0 }}>
    <legend className="settings-block-title" style={{ padding: 0 }}>KLine chart appearance</legend>
    <label className="settings-field-row"><span>Moving average</span><select className="settings-control" aria-label="KLine moving average type" value={String(draft?.movingAverageType ?? 'MA')} onChange={event => setDraft(prev => ({ ...prev, movingAverageType: event.target.value }))}><option value="MA">Simple MA</option><option value="EMA">Exponential MA</option></select></label>
    <label className="settings-field-row"><span>MA/EMA periods</span><input className="settings-control" aria-label="KLine moving average periods" value={String(draft?.movingAveragePeriods ?? '9,21')} onChange={event => setDraft(prev => ({ ...prev, movingAveragePeriods: event.target.value }))} placeholder="9,21" /></label>
    <label className="settings-field-row"><span>Chart info</span><span style={{ flex: 1 }}><input type="checkbox" checked={draft?.showChartInfo !== false} onChange={event => setDraft(prev => ({ ...prev, showChartInfo: event.target.checked }))} /> Show symbol and OHLC values</span></label>
    <small className="settings-note">MA type, periods and OHLC visibility are shared with desktop. Website charts update immediately after saving.</small>
    <div><button type="button" className="settings-primary-btn" onClick={() => void save()}>Save chart appearance</button></div>
  </fieldset>
    {message && <p role="status" className="settings-status">{message}</p>}
    {!draft && message && <button type="button" className="settings-primary-btn" onClick={() => setAttempt(value => value + 1)}>Retry chart settings</button>}
  </>;
}

import { useEffect, useState } from 'react'
import { DEFAULT_RECT_STYLE, hexToRgba, normalizeRectStyle } from '../indicators/rectangleMath'
import { CHART_APPEARANCE_EVENT, requestChartSettings } from '../indicators/rectangleStyle'
import { rendererAccountKey } from '../services/websiteChartPreferences'

/**
 * Settings -> Display. Chart drawing appearance, stored in the per-user chart-settings
 * record (`drawingFillColor` / `drawingFillOpacity`, shared with the desktop app and the
 * KLine chart). Saving does a read-modify-write so other chart-settings keys (KLine
 * appearance, desktop colours) are preserved, then notifies open charts for this account.
 */
export default function DisplaySettings() {
  const [loaded, setLoaded] = useState(false)
  const [color, setColor] = useState(DEFAULT_RECT_STYLE.fillColor)
  const [opacity, setOpacity] = useState(DEFAULT_RECT_STYLE.opacity)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    let active = true
    const owner = rendererAccountKey()
    requestChartSettings()
      .then(settings => {
        if (!active || owner !== rendererAccountKey()) return
        const style = normalizeRectStyle(settings)
        setColor(style.fillColor)
        setOpacity(style.opacity)
        setLoaded(true)
      })
      .catch(error => { if (active) setMessage({ text: String(error), error: true }) })
    return () => { active = false }
  }, [])

  async function save() {
    if (busy) return
    const owner = rendererAccountKey()
    setBusy(true)
    setMessage(null)
    try {
      const latest = await requestChartSettings()
      if (owner !== rendererAccountKey()) return
      const saved = await requestChartSettings({ ...latest, drawingFillColor: color, drawingFillOpacity: opacity })
      if (owner !== rendererAccountKey()) return
      window.dispatchEvent(new CustomEvent(CHART_APPEARANCE_EVENT, { detail: { owner, settings: saved } }))
      setMessage({ text: 'Saved. Rectangles on open charts updated.', error: false })
    } catch (error) {
      setMessage({ text: String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-block">
      <div className="settings-block-title">Rectangle drawing</div>
      <fieldset disabled={!loaded || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="settings-field-row">
          <span>Shaded fill colour</span>
          <input
            type="color" aria-label="Rectangle fill colour" value={color}
            onChange={e => setColor(e.target.value)}
            style={{ width: 44, height: 28, padding: 0, background: 'none', border: '1px solid #30363d', borderRadius: 4, cursor: 'pointer' }}
          />
          <code style={{ fontSize: 11, color: '#8b949e' }}>{color}</code>
        </label>
        <label className="settings-field-row">
          <span>Fill opacity</span>
          <input
            type="range" aria-label="Rectangle fill opacity" min={0.02} max={1} step={0.02} value={opacity}
            onChange={e => setOpacity(parseFloat(e.target.value))}
            style={{ width: 160 }}
          />
          <span style={{ flex: '0 0 auto', fontSize: 11 }}>{Math.round(opacity * 100)}%</span>
        </label>
        <div className="settings-field-row">
          <span>Preview</span>
          <div
            aria-label="Rectangle preview"
            style={{ width: 160, height: 36, borderRadius: 3, background: '#0d1117', position: 'relative', border: '1px solid #21262d', overflow: 'hidden' }}
          >
            <div style={{
              position: 'absolute', inset: '6px 24px',
              background: hexToRgba(color, opacity),
              border: `1px solid ${hexToRgba(color, Math.min(1, opacity + 0.5))}`,
            }} />
          </div>
        </div>
        <small className="settings-note">
          Used by the Rectangle tool on the Lightweight trading, Analysis, Pattern Library and Fine Structures charts. Shared with desktop and the KLine rectangle.
        </small>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="settings-primary-btn" onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save rectangle fill'}
          </button>
          <button
            type="button" onClick={() => { setColor(DEFAULT_RECT_STYLE.fillColor); setOpacity(DEFAULT_RECT_STYLE.opacity) }}
            style={{ padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid #30363d', background: '#161b22', color: '#8b949e' }}
          >
            Reset
          </button>
          {message && (
            <span role={message.error ? 'alert' : 'status'} style={{ fontSize: 11, color: message.error ? '#f85149' : '#8b949e' }}>
              {message.text}
            </span>
          )}
        </div>
      </fieldset>
    </div>
  )
}

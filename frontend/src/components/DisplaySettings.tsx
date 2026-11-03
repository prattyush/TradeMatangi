import { useEffect, useState } from 'react'
import {
  DEFAULT_RECT_STYLE, hexToRgba, normalizeRectStyle,
} from '../indicators/rectangleMath'
import { CHART_APPEARANCE_EVENT, requestChartSettings } from '../indicators/rectangleStyle'

/**
 * Settings -> Display. Chart drawing appearance, stored in the per-user chart-settings
 * record (`drawingFillColor` / `drawingFillOpacity`, shared with the desktop app).
 * Saving does a read-modify-write so other chart-settings keys are preserved.
 */
export default function DisplaySettings() {
  const [loaded, setLoaded] = useState(false)
  const [color, setColor] = useState(DEFAULT_RECT_STYLE.fillColor)
  const [opacity, setOpacity] = useState(DEFAULT_RECT_STYLE.opacity)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    let active = true
    requestChartSettings()
      .then(settings => {
        if (!active) return
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
    setBusy(true)
    setMessage(null)
    try {
      const latest = await requestChartSettings()
      const saved = await requestChartSettings({ ...latest, drawingFillColor: color, drawingFillOpacity: opacity })
      window.dispatchEvent(new CustomEvent(CHART_APPEARANCE_EVENT, { detail: { settings: saved } }))
      setMessage({ text: 'Saved. Rectangles on open charts updated.', error: false })
    } catch (error) {
      setMessage({ text: String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>RECTANGLE DRAWING</div>
      <fieldset disabled={!loaded || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#e6edf3' }}>
          <span style={{ width: 110 }}>Shaded fill colour</span>
          <input
            type="color" aria-label="Rectangle fill colour" value={color}
            onChange={e => setColor(e.target.value)}
            style={{ width: 44, height: 28, padding: 0, background: 'none', border: '1px solid #30363d', borderRadius: 4, cursor: 'pointer' }}
          />
          <code style={{ fontSize: 11, color: '#8b949e' }}>{color}</code>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#e6edf3' }}>
          <span style={{ width: 110 }}>Fill opacity</span>
          <input
            type="range" aria-label="Rectangle fill opacity" min={0.02} max={1} step={0.02} value={opacity}
            onChange={e => setOpacity(parseFloat(e.target.value))}
            style={{ width: 160 }}
          />
          <span style={{ fontSize: 11, color: '#8b949e', width: 36 }}>{Math.round(opacity * 100)}%</span>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#e6edf3' }}>
          <span style={{ width: 110 }}>Preview</span>
          <div
            aria-label="Rectangle preview"
            style={{
              width: 160, height: 36, borderRadius: 3, background: '#0d1117',
              position: 'relative', border: '1px solid #21262d', overflow: 'hidden',
            }}
          >
            <div style={{
              position: 'absolute', inset: '6px 24px',
              background: hexToRgba(color, opacity),
              border: `1px solid ${hexToRgba(color, Math.min(1, opacity + 0.5))}`,
            }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button" onClick={() => void save()}
            style={{
              padding: '5px 16px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
              border: '1px solid #1f6feb', background: '#1f3a5f', color: '#79c0ff',
            }}
          >
            {busy ? 'Saving…' : 'Save'}
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
      <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
        Used by the Rectangle tool on the trading, Pattern Library and Fine Structures charts. Shared with the desktop app.
      </div>
    </div>
  )
}

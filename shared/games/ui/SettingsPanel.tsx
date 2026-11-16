import { useState } from 'react'
import { normalizeSettings, type GamesSettings } from '../core/settings'
import { paletteHex } from '../brain/ui/palette'
import { PALETTE } from '../brain/ui/palette'

export function SettingsPanel({ settings, disabled, onSave }: { settings: GamesSettings; disabled: boolean; onSave: (next: GamesSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<GamesSettings>(settings)
  const [message, setMessage] = useState('')
  const set = <K extends keyof GamesSettings>(key: K, value: GamesSettings[K]) => setDraft(current => normalizeSettings({ ...current, [key]: value }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const hexes = paletteHex(draft.palette)
  return (
    <section aria-labelledby="games-set-title">
      <h3 id="games-set-title">Settings</h3>
      <fieldset>
        <legend>Look and feel</legend>
        <label><input type="checkbox" checked={draft.reduceMotion} onChange={event => set('reduceMotion', event.target.checked)} /> Reduce motion (no animations; Track the Dots and Equation Drop move more slowly, scoring is unchanged)</label>
        <label>Size <input type="range" min={80} max={150} step={5} value={draft.zoom} onChange={event => set('zoom', Number(event.target.value))} aria-valuetext={`${draft.zoom} percent`} /> {draft.zoom}%</label>
        <label>Colours{' '}
          <select value={draft.palette} onChange={event => set('palette', event.target.value as GamesSettings['palette'])}>
            <option value="safe">Colour-blind safe (default)</option>
            <option value="contrast">Higher contrast</option>
          </select>
        </label>
        <div className="games-swatches" aria-label="Preview of the game colours">
          {PALETTE.map((colour, i) => <span key={colour.name} className="games-swatch" style={{ background: hexes[i] }} title={colour.name}>{colour.name.slice(0, 3)}</span>)}
        </div>
        <p className="games-meta">Every colour in a game also has a name, a shape or a pattern, so no game depends on telling colours apart.</p>
      </fieldset>
      <fieldset>
        <legend>Sound and memory</legend>
        <label><input type="checkbox" checked={draft.sound} onChange={event => set('sound', event.target.checked)} /> Sound (short tones on the countdown and the result; off by default)</label>
        <label><input type="checkbox" checked={draft.lowMemory} onChange={event => set('lowMemory', event.target.checked)} /> Low memory mode</label>
      </fieldset>
      <fieldset>
        <legend>Daily Warm-up</legend>
        <label>Warm-up games <select value={draft.warmupPool} onChange={event => set('warmupPool', event.target.value as GamesSettings['warmupPool'])}><option value="both">Brain and market</option><option value="market">Market only</option><option value="brain">Brain only</option></select></label>
        <p className="games-meta">Until the market games arrive, every choice uses brain games.</p>
      </fieldset>
      <div className="games-row">
        <button disabled={disabled || !dirty} onClick={() => { setMessage('Saving…'); onSave(draft).then(() => setMessage('Saved.'), error => setMessage(`Could not save: ${String(error instanceof Error ? error.message : error)}`)) }}>Save settings</button>
        <span role="status">{message}</span>
      </div>
      <p className="games-meta">These games are practice tools, not a medical product. They do not claim to improve intelligence, memory, health or trading results.</p>
    </section>
  )
}

export const guardrailFields = [
  ['guardrail_block_bars', 'Block duration (additional bars)', 0, 20, 1],
  ['guardrail_cooldown_enabled', 'Enable Cooldown'],
  ['guardrail_cooldown_losses', 'Consecutive losses', 1, 20, 1],
  ['guardrail_cooldown_block_bars', 'Cooldown duration (additional bars)', 1, 20, 1],
  ['guardrail_ban_enabled', 'Enable Ban'],
  ['guardrail_ban_capital_pct', 'Capital loss limit (%)', 1, 100, 0.1],
  ['guardrail_ban_loss_trade_pct', 'Losing trades limit (%)', 1, 100, 0.1],
  ['guardrail_ban_min_trades', 'Minimum completed trades for Ban', 1, 100, 1],
  ['guardrail_maxsize_enabled', 'Enable Max Size'],
  ['guardrail_maxsize_mode', 'Max Size mode'],
  ['guardrail_maxsize_pct', 'Max Size (% of capital)', 1, 100, 0.1],
  ['guardrail_maxsize_value', 'Max Size value (₹)', 0, undefined, 0.1],
] as const

export function GuardrailFields({ draft, onChange }: { draft: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  return <section className="settings-section"><strong>GuardRails & Block</strong><p>Changes apply to new sessions. Block pauses trading for the current bar plus the configured additional bars. Restrictions cannot be overridden.</p><div className="picker-fields">{guardrailFields.map(([key, label, min, max, step]) => <label key={key}>{label}{key.endsWith('_enabled') ? <input type="checkbox" checked={Boolean(draft[key])} onChange={e => onChange({ ...draft, [key]: e.target.checked })} /> : key.endsWith('_mode') ? <select value={String(draft[key])} onChange={e => onChange({ ...draft, [key]: e.target.value })}><option value="percentage">Percentage</option><option value="value">Value</option></select> : <input type="number" required min={min} max={max} step={step} value={String(draft[key] ?? '')} onChange={e => onChange({ ...draft, [key]: e.target.value === '' ? '' : Number(e.target.value) })} />}</label>)}</div></section>
}

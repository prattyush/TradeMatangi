interface Props {
  type: 'BLOCK' | 'COOLDOWN' | 'BAN'
  reason: string
  onClose?: () => void
}

const TYPE_COLOR: Record<string, string> = {
  BLOCK: '#f0883e',
  COOLDOWN: '#d29922',
  BAN: '#f85149',
}

const TYPE_LABEL: Record<string, string> = {
  BLOCK: 'Trading Paused',
  COOLDOWN: 'Cooldown Active',
  BAN: 'Trading Suspended',
}

export default function GuardRailPopup({ type, reason, onClose }: Props) {
  const color = TYPE_COLOR[type] ?? '#f0883e'
  const label = TYPE_LABEL[type] ?? 'GuardRail Active'
  const isBan = type === 'BAN'

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 2000,
    }}>
      <div style={{
        background: '#161b22', border: `1px solid ${color}`,
        borderRadius: 10, padding: '24px 28px', maxWidth: 380, width: '90%',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>{isBan ? '' : ''}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color }}>{label}</span>
          {!isBan && onClose && (
            <button
              onClick={onClose}
              style={{
                marginLeft: 'auto', background: 'none', border: 'none',
                color: '#8b949e', cursor: 'pointer', fontSize: 16,
              }}
            >✕</button>
          )}
        </div>

        <div style={{
          background: '#0d1117', borderRadius: 6, padding: '10px 14px',
          fontSize: 13, color: '#e6edf3', lineHeight: 1.5,
        }}>
          {reason}
        </div>

        {isBan && (
          <div style={{ fontSize: 11, color: '#8b949e' }}>
            Trading is suspended for the rest of this session. Start a new session to resume trading.
          </div>
        )}

        {!isBan && onClose && (
          <button
            onClick={onClose}
            style={{
              alignSelf: 'flex-end', background: '#21262d',
              border: `1px solid ${color}`, color, borderRadius: 6,
              padding: '6px 18px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
            }}
          >
            Got it
          </button>
        )}
      </div>
    </div>
  )
}

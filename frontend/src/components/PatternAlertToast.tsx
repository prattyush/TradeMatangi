import { useEffect, useRef } from 'react'

export interface PatternAlert {
  id: number
  pattern: string
  category: string
  title: string
  severity: string
  description: string
  trade_suggestion?: string | null
}

interface Props {
  alerts: PatternAlert[]
  onDismiss: (id: number) => void
}

const CATEGORY_COLOR: Record<string, string> = {
  trend:      '#1f6feb',
  reversal:   '#d29922',
  range:      '#8957e5',
  ema:        '#3fb950',
  level:      '#79c0ff',
  behavioral: '#f85149',
}

const SEVERITY_ICON: Record<string, string> = {
  info:     '●',
  warning:  '▲',
  critical: '⬟',
}

function AlertCard({ alert, onDismiss }: { alert: PatternAlert; onDismiss: () => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const color = CATEGORY_COLOR[alert.category] ?? '#8b949e'
  const icon  = SEVERITY_ICON[alert.severity]  ?? '●'
  const autoMs = alert.severity === 'critical' ? 12000 : 8000

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, autoMs)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  return (
    <div
      style={{
        background: '#161b22',
        border: `1px solid ${color}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 8,
        minWidth: 280,
        maxWidth: 340,
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        animation: 'slideInRight 0.2s ease-out',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color, fontSize: 10 }}>{icon}</span>
          <span style={{ color: '#e6edf3', fontSize: 12, fontWeight: 600 }}>{alert.title}</span>
        </div>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', color: '#484f58',
            cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px',
          }}
        >✕</button>
      </div>

      {/* Description */}
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: alert.trade_suggestion ? 6 : 0 }}>
        {alert.description}
      </div>

      {/* Trade suggestion */}
      {alert.trade_suggestion && (
        <div style={{
          fontSize: 11, color: '#79c0ff',
          borderTop: '1px solid #21262d',
          paddingTop: 5, marginTop: 4,
        }}>
          💡 {alert.trade_suggestion}
        </div>
      )}
    </div>
  )
}

export default function PatternAlertToast({ alerts, onDismiss }: Props) {
  if (alerts.length === 0) return null

  return (
    <>
      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      <div
        style={{
          position: 'fixed',
          top: 64,
          right: 16,
          zIndex: 1500,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      >
        {alerts.map(a => (
          <div key={a.id} style={{ pointerEvents: 'auto' }}>
            <AlertCard alert={a} onDismiss={() => onDismiss(a.id)} />
          </div>
        ))}
      </div>
    </>
  )
}

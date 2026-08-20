import { useEffect } from 'react'

interface Props {
  message: string
  onYes: () => void
  onNo: () => void
}

export default function ConfirmModal({ message, onYes, onNo }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onNo()
      if (e.key === 'Enter') onYes()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onYes, onNo])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
        padding: 28, minWidth: 320, maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <p style={{ margin: 0, fontSize: 14, color: '#e6edf3', lineHeight: 1.6 }}>
          {message}
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onNo}
            style={{
              background: 'none', border: '1px solid #30363d', borderRadius: 6,
              color: '#8b949e', padding: '7px 20px', cursor: 'pointer', fontSize: 13,
            }}
          >No</button>
          <button
            onClick={onYes}
            autoFocus
            style={{
              background: '#1f6feb', border: 'none', borderRadius: 6,
              color: '#e6edf3', padding: '7px 20px', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
            }}
          >Yes</button>
        </div>
      </div>
    </div>
  )
}

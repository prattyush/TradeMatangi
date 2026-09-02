import { useEffect, useRef } from 'react'

export interface ContextMenuAction {
  label: string
  color?: string
  disabled?: boolean
  submenu?: ContextMenuAction[]
  onClick?: () => void
}

interface ChartContextMenuProps {
  x: number
  y: number
  price: number
  actions: ContextMenuAction[]
  onClose: () => void
}

export default function ChartContextMenu({ x, y, price, actions, onClose }: ChartContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [onClose])

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 220)
  const adjustedY = Math.min(y, window.innerHeight - 300)

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: adjustedX,
        top: adjustedY,
        zIndex: 10000,
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: 8,
        padding: '4px 0',
        minWidth: 180,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ padding: '4px 12px', fontSize: 11, color: '#8b949e', borderBottom: '1px solid #21262d', marginBottom: 4 }}>
        ₹{price.toFixed(2)}
      </div>
      {actions.map((action, i) => (
        <ContextMenuItem key={i} action={action} onClose={onClose} depth={0} />
      ))}
    </div>
  )
}

function ContextMenuItem({ action, onClose, depth }: { action: ContextMenuAction; onClose: () => void; depth: number }) {
  const itemRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const hasSubmenu = action.submenu && action.submenu.length > 0

  return (
    <div
      ref={itemRef}
      style={{ position: 'relative' }}
      onMouseEnter={() => {
        if (hasSubmenu && submenuRef.current) submenuRef.current.style.display = 'block'
      }}
      onMouseLeave={() => {
        if (hasSubmenu && submenuRef.current) submenuRef.current.style.display = 'none'
      }}
    >
      <div
        onClick={() => {
          if (action.disabled) return
          if (hasSubmenu) return
          action.onClick?.()
          onClose()
        }}
        style={{
          padding: '6px 12px',
          fontSize: 12,
          color: action.disabled ? '#484f58' : (action.color || '#e6edf3'),
          cursor: action.disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => { if (!action.disabled) (e.currentTarget as HTMLElement).style.background = '#1f3a5f' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <span>{action.label}</span>
        {hasSubmenu && <span style={{ fontSize: 10, color: '#484f58' }}>▸</span>}
      </div>
      {hasSubmenu && (
        <div
          ref={submenuRef}
          style={{
            display: 'none',
            position: 'absolute',
            left: '100%',
            top: -4,
            zIndex: 10001,
            background: '#161b22',
            border: '1px solid #30363d',
            borderRadius: 8,
            padding: '4px 0',
            minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {action.submenu!.map((sub, j) => (
            <ContextMenuItem key={j} action={sub} onClose={onClose} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

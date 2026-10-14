import type { ButtonHTMLAttributes } from 'react'

const paths = {
  LeftHide: 'M3 4h18v16H3z M8 4v16 M15 9l-3 3 3 3',
  LeftShow: 'M3 4h18v16H3z M8 4v16 M12 9l3 3-3 3',
  RightHide: 'M3 4h18v16H3z M16 4v16 M9 9l3 3-3 3',
  RightShow: 'M3 4h18v16H3z M16 4v16 M12 9l-3 3 3 3',
  Play: 'M8 4l12 8-12 8z',
  Pause: 'M7 4v16 M17 4v16',
  PopOut: 'M14 3h7v7 M21 3l-9 9 M10 3H3v18h18v-7',
  Link: 'M9 14l6-4 M10 7l2-2a4 4 0 0 1 6 6l-2 2 M14 17l-2 2a4 4 0 0 1-6-6l2-2',
  History: 'M4 7a9 9 0 1 1-1 8 M4 3v5H1 M12 7v5l3 2',
  Stats: 'M3 20V4 M3 20h18 M7 16v-4 M12 16V7 M17 16v-7',
  Manage: 'M3 7h18v13H3z M8 7V4h8v3 M3 12h18 M10 12v3h4v-3',
  Detach: 'M9 4H3v16h6 M11 12h10 M17 8l4 4-4 4',
  ToolsHide: 'M6 14l6-6 6 6',
  ToolsShow: 'M6 10l6 6 6-6',
  Today: 'M3 5h18v16H3z M7 3v4 M17 3v4 M3 10h18 M9 14h6v4H9z',
  Maximize: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
  Restore: 'M3 8h5V3 M21 8h-5V3 M3 16h5v5 M21 16h-5v5',
  Indicator: 'M3 18c4 0 3-12 7-12s3 12 7 12 3-12 4-12',
  Horizontal: 'M3 12h18 M3 9v6 M21 9v6',
  Trend: 'M3 19L21 5 M3 16v6 M21 2v6',
  Fib: 'M3 4h18 M3 9h13 M3 14h8 M3 20h18',
  Delete: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
} as const

export function SwingIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function SwingIconButton({ label, icon, className = '', ...props }: {
  label: string; icon: keyof typeof paths
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title' | 'aria-label'>) {
  return <button {...props} type={props.type ?? 'button'} className={`swing-icon-button ${className}`} title={label} aria-label={label}><SwingIcon name={icon} /></button>
}

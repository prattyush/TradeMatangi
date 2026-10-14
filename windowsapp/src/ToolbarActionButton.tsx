import { Children, type ButtonHTMLAttributes } from 'react'
import { ToolbarIcon } from './ToolbarIcon'

/** Retain each action's text as its tooltip and accessible name. */
export function ToolbarActionButton({ icon, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string }) {
  const label = Children.toArray(children).join('')
  return <button {...props} className={`icon-button toolbar-icon-button ${className}`} title={label} aria-label={label} data-tooltip={label}><ToolbarIcon name={icon} /></button>
}

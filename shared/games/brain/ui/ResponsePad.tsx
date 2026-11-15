import type { ReactNode } from 'react'
import { KeyHint } from './KeyHint'

export interface PadButton { id: string; label: ReactNode; hint?: string; onPress: (timeStamp: number) => void; disabled?: boolean }

/**
 * Answer buttons for mouse and trackpad. They respond on pointer *down* with the event's own `timeStamp` (the reaction-time
 * source), and never take keyboard focus, so the game's focused root keeps the keyboard.
 */
export function ResponsePad({ buttons }: { buttons: PadButton[] }) {
  return (
    <div className="brain-pad">
      {buttons.map(button => (
        <button key={button.id} type="button" tabIndex={-1} disabled={button.disabled}
          onPointerDown={event => { event.preventDefault(); button.onPress(event.timeStamp) }}>
          <span>{button.label}</span>{button.hint && <KeyHint>{button.hint}</KeyHint>}
        </button>
      ))}
    </div>
  )
}

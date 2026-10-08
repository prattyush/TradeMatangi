import { useEffect, useRef, type InputHTMLAttributes } from 'react'
import { incrementValue } from './orderEditing'

export function StepInput({ value, onValue, step, min, max, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'step' | 'min' | 'max'> & { value: string; onValue: (value: string) => void; step: number; min: number; max?: number }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const node = input.current
    const wheel = (event: WheelEvent) => { if (node && document.activeElement === node && event.deltaY !== 0 && !node.disabled) { event.preventDefault(); onValue(incrementValue(value, event.deltaY < 0 ? 1 : -1, step, min, max)) } }
    node?.addEventListener('wheel', wheel, { passive: false })
    return () => node?.removeEventListener('wheel', wheel)
  }, [value, onValue, step, min, max])
  // A fractional min (e.g. .01) also becomes the browser's step base, making
  // spinner clicks go from 90 to 90.01 instead of 90.25. Keep positive-price
  // validation at submission and preserve the supplied min for our key/wheel path.
  return <input {...props} ref={input} type="number" value={value} step={step} min={step < 1 ? undefined : min} aria-valuemin={min} max={max} onChange={event => onValue(event.target.value)}
    onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onValue(incrementValue(value, event.key === 'ArrowUp' ? 1 : -1, step, min, max)) } }}
    />
}

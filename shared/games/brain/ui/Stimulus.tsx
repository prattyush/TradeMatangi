import { PALETTE, NEUTRAL_GREY } from './palette'
import { POLYGONS, polygonPath } from './shapes'

/** Fill patterns so colour is never the only cue (colour-vision-safe, spec 17.3). Render `<PatternDefs/>` once per view. */
/** `scale` shrinks the pattern tile (small shapes in a 100-unit arena); `prefix` keeps two sets of ids apart. */
export function PatternDefs({ scale = 1, prefix = 'brain-pat' }: { scale?: number; prefix?: string } = {}) {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
      <defs>
        {PALETTE.map((colour, i) => (
          <pattern key={colour.name} id={`${prefix}-${i}`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform={`scale(${scale})`}>
            <rect width="12" height="12" fill={colour.hex} />
            {colour.pattern === 'stripes' && <path d="M-2 2 L2 -2 M0 12 L12 0 M10 14 L14 10" stroke="#00000066" strokeWidth="2.5" />}
            {colour.pattern === 'dots' && <><circle cx="3" cy="3" r="1.8" fill="#ffffffaa" /><circle cx="9" cy="9" r="1.8" fill="#ffffffaa" /></>}
            {colour.pattern === 'cross' && <path d="M0 6 H12 M6 0 V12" stroke="#00000055" strokeWidth="1.6" />}
            {colour.pattern === 'ring' && <circle cx="6" cy="6" r="3.2" fill="none" stroke="#00000066" strokeWidth="1.6" />}
            {colour.pattern === 'half' && <rect width="6" height="12" fill="#00000040" />}
          </pattern>
        ))}
      </defs>
    </svg>
  )
}

export const patternFill = (colourIndex: number, prefix = 'brain-pat'): string => `url(#${prefix}-${((colourIndex % PALETTE.length) + PALETTE.length) % PALETTE.length})`

interface ShapeProps {
  /** 0 = circle, 1-5 = the polygons in `shapes.ts`; or a named basic shape. */
  shape: number | 'circle' | 'square' | 'triangle'
  colour: number
  /** Edge in px. */
  size?: number
  scale?: number
  rotation?: number
  mirrored?: boolean
  label?: string
}

/** One stimulus: a coloured, patterned shape. Mirroring is applied before rotation, as in the engine. */
export function Shape({ shape, colour, size = 96, scale = 1, rotation = 0, mirrored = false, label }: ShapeProps) {
  const fill = patternFill(colour)
  const common = { fill, stroke: NEUTRAL_GREY, strokeWidth: 2.5 }
  let body
  if (shape === 0 || shape === 'circle') body = <circle r="40" {...common} />
  else if (shape === 'square') body = <rect x="-38" y="-38" width="76" height="76" {...common} />
  else if (shape === 'triangle') body = <path d="M0 -42 L42 34 L-42 34 Z" {...common} />
  else body = <path d={polygonPath(POLYGONS[shape])} {...common} strokeLinejoin="round" />
  return (
    // The box is wider than the 100 x 100 drawing so a scaled or rotated shape is never clipped.
    <svg width={size * 1.6} height={size * 1.6} viewBox="-80 -80 160 160" role="img" aria-label={label}>
      <g transform={`rotate(${rotation}) scale(${mirrored ? -scale : scale} ${scale})`}>{body}</g>
    </svg>
  )
}

/** A small swatch used on answer buttons: pattern fill plus its position number. */
export function Swatch({ colour, size = 28 }: { colour: number; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="2" width="24" height="24" rx="5" fill={patternFill(colour)} stroke={NEUTRAL_GREY} strokeWidth="1.5" /></svg>
}

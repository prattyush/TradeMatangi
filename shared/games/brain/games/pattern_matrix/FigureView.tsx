import { PALETTE, NEUTRAL_GREY } from '../../ui/palette'
import { patternFill } from '../../ui/Stimulus'
import type { Figure } from './generator'

export const PM_PREFIX = 'brain-pm'
const SIZE_SCALE = [0.55, 0.8, 1.05]
const COUNT_SCALE = [1, 0.72, 0.62, 0.55]
const POSITIONS: Array<Array<[number, number]>> = [[[0, 0]], [[-20, 0], [20, 0]], [[-20, 14], [20, 14], [0, -20]], [[-20, -20], [20, -20], [-20, 20], [20, 20]]]
const SIDES = [0, 4, 3, 5, 6]

function shapePoints(sides: number, radius: number): string {
  // A square sits flat (rotated 45 degrees from the "vertex up" start); the others point up.
  const offset = sides === 4 ? Math.PI / 4 : 0
  return Array.from({ length: sides }, (_, i) => {
    const angle = -Math.PI / 2 + offset + (2 * Math.PI * i) / sides
    return `${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`
  }).join(' ')
}

/** One figure of the matrix: shape, count (the attribute value 0 to 3 means 1 to 4 shapes), size, colour (with a pattern), turn (a tick shows it) and shading. `size` is in px. */
export function FigureView({ figure, size = 84, label }: { figure: Figure; size?: number; label?: string }) {
  const colour = PALETTE[figure.colour % PALETTE.length]
  const radius = 24 * SIZE_SCALE[figure.size] * COUNT_SCALE[figure.count]
  const sides = SIDES[figure.shape]
  const fill = figure.shading === 2 ? 'none' : patternFill(figure.colour, PM_PREFIX)
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" role="img" aria-label={label}>
      {POSITIONS[figure.count].map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y}) rotate(${figure.rotation * 45})`}>
          {sides === 0
            ? <circle r={radius} fill={fill} fillOpacity={figure.shading === 1 ? 0.45 : 1} stroke={colour.hex} strokeWidth={figure.shading === 2 ? 3 : 1.5} />
            : <polygon points={shapePoints(sides, radius)} fill={fill} fillOpacity={figure.shading === 1 ? 0.45 : 1} stroke={colour.hex} strokeWidth={figure.shading === 2 ? 3 : 1.5} strokeLinejoin="round" />}
          <circle cx={0} cy={-radius * 0.62} r={Math.max(1.6, radius * 0.1)} fill={NEUTRAL_GREY} />
        </g>
      ))}
      {figure.mask > 0 && [0, 1, 2, 3].map(bit => (
        <circle key={bit} cx={34 + (bit % 2) * 9} cy={-42 + Math.floor(bit / 2) * 9} r={3.2} fill={figure.mask & (1 << bit) ? NEUTRAL_GREY : 'none'} stroke={NEUTRAL_GREY} strokeWidth={0.8} />
      ))}
    </svg>
  )
}

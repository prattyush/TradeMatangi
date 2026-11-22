/**
 * Colour-vision-safe palette (Okabe-Ito) for the brain games. The set's black is replaced by a light grey because the games
 * sit on a dark background. Colour is never the only cue: every colour-coded stimulus also carries a shape, a pattern or a
 * label (spec 17.3). No third-party icon packs or fonts.
 */
export interface PaletteColour { name: string; hex: string; /** SVG pattern id used on buttons so colour is never alone */ pattern: 'solid' | 'stripes' | 'dots' | 'cross' | 'ring' | 'half' }

export const PALETTE: readonly PaletteColour[] = [
  { name: 'ORANGE', hex: '#E69F00', pattern: 'stripes' },
  { name: 'BLUE', hex: '#0072B2', pattern: 'dots' },
  { name: 'GREEN', hex: '#009E73', pattern: 'cross' },
  { name: 'RED', hex: '#D55E00', pattern: 'ring' },
  { name: 'YELLOW', hex: '#F0E442', pattern: 'half' },
  { name: 'PINK', hex: '#CC79A7', pattern: 'solid' },
] as const

export const NEUTRAL_GREY = '#D0D7DE'
export const colourAt = (index: number): PaletteColour => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]

/** The `contrast` palette: the same six hues in lighter values that stand out more on the dark background. */
const CONTRAST_HEX = ['#FFB000', '#4DA6FF', '#00D69B', '#FF6A2B', '#FFF04D', '#FF9AD5'] as const
const SAFE_HEX = PALETTE.map(colour => colour.hex)
export type PaletteChoice = 'safe' | 'contrast'

/** Switch the live palette. Names and patterns never change, so engines and scoring are untouched; only the paint changes. */
export const paletteHex = (name: PaletteChoice): readonly string[] => (name === 'contrast' ? CONTRAST_HEX : SAFE_HEX)
export function applyPalette(name: PaletteChoice): void {
  const hexes = paletteHex(name)
  PALETTE.forEach((colour, i) => { (colour as { hex: string }).hex = hexes[i] })
}

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

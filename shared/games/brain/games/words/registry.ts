import { generateAnagramSet } from '../anagram_dash/generator'
import { generateGridSet } from '../letter_grid/generator'
import { generateLadderSet } from '../word_ladder/generator'

/** The generators the words worker (and the inline fallback) can run. They load the word lists themselves (lazily). */
export const WORD_GENERATORS = { anagramDash: generateAnagramSet, letterGrid: generateGridSet, wordLadder: generateLadderSet }

/**
 * Game registrations: one import and one `registerGame(...)` line per game (spec 4.1, 12). The hub lists every catalogue
 * entry and shows the ones not registered here as "Coming soon".
 */
import quickMatch from '../brain/games/quick_match'
import colourClash from '../brain/games/colour_clash'
import greenLight from '../brain/games/green_light'
import { isPlayable, registerGame } from '../core/registry'

for (const definition of [quickMatch, colourClash, greenLight]) if (!isPlayable(definition.id)) registerGame(definition)

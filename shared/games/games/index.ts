/**
 * Game registrations: one import and one `registerGame(...)` line per game (spec 4.1, 12). The hub lists every catalogue
 * entry and shows the ones not registered here as "Coming soon".
 */
import quickMatch from '../brain/games/quick_match'
import colourClash from '../brain/games/colour_clash'
import greenLight from '../brain/games/green_light'
import gridRecall from '../brain/games/grid_recall'
import sequenceEcho from '../brain/games/sequence_echo'
import nBackStream from '../brain/games/n_back_stream'
import flankerFlock from '../brain/games/flanker_flock'
import needleFinder from '../brain/games/needle_finder'
import trackTheDots from '../brain/games/track_the_dots'
import ruleSwitch from '../brain/games/rule_switch'
import cardSorter from '../brain/games/card_sorter'
import flipMap from '../brain/games/flip_map'
import numberSprint from '../brain/games/number_sprint'
import equationDrop from '../brain/games/equation_drop'
import makeTarget from '../brain/games/make_target'
import { isPlayable, registerGame } from '../core/registry'

for (const definition of [quickMatch, colourClash, greenLight, gridRecall, sequenceEcho, nBackStream, flankerFlock, needleFinder, trackTheDots, ruleSwitch, cardSorter, flipMap, numberSprint, equationDrop, makeTarget]) {
  if (!isPlayable(definition.id)) registerGame(definition)
}

/** Web Worker entry: builds Make Target puzzle sets off the main thread (spec 17.7, C7). */
import { installWorkerRuntime, type GeneratorFn, type WorkerScope } from '../../engine/generatorHost'
import { generatePuzzles } from './solver'

installWorkerRuntime({ makeTarget: generatePuzzles as unknown as GeneratorFn }, self as unknown as WorkerScope)

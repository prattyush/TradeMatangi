/** Web Worker entry: builds the Word games' puzzle sets off the main thread (spec 17.7, C7). The lists are decoded here and freed when the worker ends. */
import { installWorkerRuntime, type GeneratorFn, type WorkerScope } from '../../engine/generatorHost'
import { WORD_GENERATORS } from './registry'

installWorkerRuntime(WORD_GENERATORS as unknown as Record<string, GeneratorFn>, self as unknown as WorkerScope)

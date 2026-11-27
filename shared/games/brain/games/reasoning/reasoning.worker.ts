/** Web Worker entry: builds the Reasoning games' puzzle sets off the main thread (spec 17.7, C7). */
import { installWorkerRuntime, type GeneratorFn, type WorkerScope } from '../../engine/generatorHost'
import { REASONING_GENERATORS } from './registry'

installWorkerRuntime(REASONING_GENERATORS as unknown as Record<string, GeneratorFn>, self as unknown as WorkerScope)

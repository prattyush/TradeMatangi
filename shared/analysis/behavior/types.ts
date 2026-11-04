import type websiteApi from '../../../frontend/src/services/api'

/** The behavior question/mark operations; implemented by the website API, the desktop Analysis proxy and the desktop trading routes. */
export type BehaviorApi = Pick<typeof websiteApi,
  'getBehaviorQuestions' | 'addBehaviorQuestion' | 'updateBehaviorQuestion' | 'archiveBehaviorQuestion' |
  'restoreBehaviorQuestion' | 'getBehaviorMarks' | 'saveBehaviorMarks'>

/** Server validation text lives in `detail`; desktop transports embed the whole JSON body in the error message. */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const detail = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)
  return detail ? detail[1].replace(/\\"/g, '"') : message
}

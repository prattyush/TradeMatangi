import { createContext, useContext } from 'react'

/** What the labeling screen's chart needs from its host: a way to leave the screen. */
interface LabelingHost { requestClose(): void }

export const LabelingHostContext = createContext<LabelingHost>({ requestClose: () => {} })
export const useLabelingHost = (): LabelingHost => useContext(LabelingHostContext)

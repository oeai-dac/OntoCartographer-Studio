import { createContext, useContext } from 'react'
import { DEFAULT_LANGUAGES } from '../utils/languages.js'

// The project's languages and the canvas-wide display language, handed to the
// node components through context rather than through node data.
//
// Node data would be the obvious place, but every node receives its callback
// bundle once, at creation — a node created before the language set changed
// would keep rendering the old one. Context also keeps the language out of
// the project file's node entries, where it has no business being: it is a
// project property, stored once at the top level.
//
// `activeLang` is view state only. It is never saved and never read by any
// exporter; it decides which language the two label rows currently show.
export const LanguageViewContext = createContext({
  languages: DEFAULT_LANGUAGES,
  activeLang: DEFAULT_LANGUAGES.primary,
})

export function useLanguageView() {
  return useContext(LanguageViewContext)
}

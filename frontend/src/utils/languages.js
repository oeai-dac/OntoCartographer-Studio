// ─── Project languages ───────────────────────────────────────────────────────
//
// Labels can be given in several languages. The languages are a property of
// the PROJECT, not of the individual node: the user defines them once, and
// every node then offers exactly those slots. That is what keeps the node UI
// to a single chip per label row instead of a language picker per field.
//
// Storage rule (the reason nothing else in the codebase had to change):
// the existing flat fields — `instanceLabel`, `explorerLabel`, `labelColumn` —
// keep holding the PRIMARY language. Only the ADDITIONAL languages go into a
// sibling map. A project with one language therefore writes byte-identical
// node data, byte-identical TSV and byte-identical RDF to before, and every
// consumer that reads the flat field (verification, the prefix scan, GraphML,
// the collapsed-node icons) keeps working without knowing languages exist.

export const DEFAULT_LANGUAGES = { primary: 'de', additional: [] }

// Flat field -> sibling map holding the additional languages.
export const I18N_FIELDS = {
  instanceLabel: 'instanceLabelI18n',
  explorerLabel: 'explorerLabelI18n',
  labelColumn:   'labelColumnI18n',
}

// Deliberately permissive: a BCP-47 tag is `de`, `en`, `de-AT`, `gsw-u-sd-chzh`.
// We only reject what would break an RDF literal's language tag.
const LANG_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/

export function isValidLangTag(tag) {
  return typeof tag === 'string' && LANG_TAG.test(tag.trim())
}

export function normalizeLangTag(tag) {
  return String(tag || '').trim().toLowerCase()
}

/**
 * Bring any stored/user-supplied shape into the canonical one. Guarantees a
 * non-empty primary, lowercase tags, no duplicates and no primary hiding in
 * the additional list — every consumer can then skip its own defensiveness.
 */
export function normalizeLanguages(raw) {
  const primary = normalizeLangTag(raw?.primary) || DEFAULT_LANGUAGES.primary
  const seen = new Set([primary])
  const additional = []
  for (const t of (Array.isArray(raw?.additional) ? raw.additional : [])) {
    const tag = normalizeLangTag(t)
    if (!tag || !isValidLangTag(tag) || seen.has(tag)) continue
    seen.add(tag)
    additional.push(tag)
  }
  return { primary, additional }
}

/** Primary first — that order is what the chips and the language menu render. */
export function allLanguages(langs) {
  const l = normalizeLanguages(langs)
  return [l.primary, ...l.additional]
}

export function isMultilingual(langs) {
  return allLanguages(langs).length > 1
}

/**
 * Read one field in one language. `lang` falsy or equal to the primary reads
 * the flat field, anything else the sibling map.
 */
export function getLangValue(data, field, lang, langs) {
  if (!data) return ''
  const l = normalizeLanguages(langs)
  const tag = normalizeLangTag(lang) || l.primary
  if (tag === l.primary) return data[field] || ''
  const map = data[I18N_FIELDS[field]]
  return (map && map[tag]) || ''
}

/**
 * Partial node-data patch that writes one field in one language. Empty values
 * delete the entry rather than storing '' — so a map that ends up empty is
 * dropped entirely and the saved project keeps no trace of a language the
 * node never used.
 */
export function patchLangValue(data, field, lang, value, langs) {
  const l = normalizeLanguages(langs)
  const tag = normalizeLangTag(lang) || l.primary
  const v = typeof value === 'string' ? value.trim() : value

  // The primary language keeps writing the flat field exactly as before,
  // including its "unset" spelling: `labelColumn` clears to null (that is
  // what the column-drop handler has always passed), text fields to ''.
  if (tag === l.primary) return { [field]: v == null ? null : v }

  const key = I18N_FIELDS[field]
  const next = { ...(data?.[key] || {}) }
  if (v) next[tag] = v
  else delete next[tag]
  return { [key]: Object.keys(next).length > 0 ? next : undefined }
}

/** Every non-empty value of one field, keyed by language. */
export function langValues(data, field, langs) {
  const out = {}
  for (const tag of allLanguages(langs)) {
    const v = getLangValue(data, field, tag, langs)
    if (v) out[tag] = v
  }
  return out
}

/** Just the additional languages' non-empty values — what the TSV carries. */
export function additionalLangValues(data, field, langs) {
  const l = normalizeLanguages(langs)
  const out = {}
  for (const tag of l.additional) {
    const v = getLangValue(data, field, tag, langs)
    if (v) out[tag] = v
  }
  return out
}

/**
 * True when this node has any label text at all in `lang` — either typed or
 * via a mapped column. Drives the filled/empty state of the language chips
 * and the "missing translation" check in Verify.
 */
export function hasLabelIn(data, lang, langs) {
  return !!(getLangValue(data, 'labelColumn', lang, langs) ||
            getLangValue(data, 'instanceLabel', lang, langs))
}

export function hasExplorerLabelIn(data, lang, langs) {
  return !!getLangValue(data, 'explorerLabel', lang, langs)
}

/**
 * Re-anchor a node's stored values when the project's language set changes.
 *
 * This is not cosmetic. The flat field means "primary language" — so simply
 * switching the primary from de to en would leave the German text sitting in
 * the field that the exporter now tags @en, which is precisely the bug this
 * whole feature exists to fix. Values are therefore lifted into a full
 * {lang: value} map and re-split against the NEW primary.
 *
 * Values in languages that no longer exist are dropped; `languagesLosingData`
 * lets the caller warn about that before it happens.
 */
export function remapNodeLanguages(data, oldLangs, newLangs) {
  const from = normalizeLanguages(oldLangs)
  const to   = normalizeLanguages(newLangs)
  if (from.primary === to.primary &&
      from.additional.join(',') === to.additional.join(',')) return data

  const patch = {}
  for (const field of Object.keys(I18N_FIELDS)) {
    const full = {}
    for (const tag of allLanguages(from)) {
      const v = getLangValue(data, field, tag, from)
      if (v) full[tag] = v
    }
    patch[field] = full[to.primary] || ''
    const rest = {}
    for (const tag of to.additional) {
      if (full[tag]) rest[tag] = full[tag]
    }
    patch[I18N_FIELDS[field]] = Object.keys(rest).length > 0 ? rest : undefined
  }
  return { ...data, ...patch }
}

/**
 * Which of the languages about to disappear actually hold values, and on how
 * many nodes. Returns [{ lang, nodeCount }], empty when nothing would be lost.
 */
export function languagesLosingData(nodes, oldLangs, newLangs) {
  const from = normalizeLanguages(oldLangs)
  const to   = new Set(allLanguages(newLangs))
  const doomed = allLanguages(from).filter(t => !to.has(t))
  if (doomed.length === 0) return []

  return doomed.map(lang => {
    let nodeCount = 0
    for (const n of (nodes || [])) {
      if (n.type === 'dotOneMidpoint') continue
      const d = n.data || {}
      const used = Object.keys(I18N_FIELDS).some(f => !!getLangValue(d, f, lang, from))
      if (used) nodeCount++
    }
    return { lang, nodeCount }
  }).filter(x => x.nodeCount > 0)
}

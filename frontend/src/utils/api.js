const BASE = '/api'

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

export const api = {
  health: () => req('/health'),

  uploadOntologies: (files) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    return req('/ontology/upload', { method: 'POST', body: form })
  },

  listOntologies: () => req('/ontology/list'),

  deleteOntology: (filename) =>
    req(`/ontology/${encodeURIComponent(filename)}`, { method: 'DELETE' }),

  getClasses: (search = '') =>
    req(`/ontology/classes?search=${encodeURIComponent(search)}`),

  getProperties: (subjectUri, search = '', widening = false, inheritance = true) =>
    req(`/ontology/properties?subject_uri=${encodeURIComponent(subjectUri)}&search=${encodeURIComponent(search)}&widening=${widening}&inheritance=${inheritance}`),

  getRange: (subjectUri, propertyUri) =>
    req(`/ontology/range?subject_uri=${encodeURIComponent(subjectUri)}&property_uri=${encodeURIComponent(propertyUri)}`),

  // Hierarchy / inference endpoints (new v1.1)
  getHierarchy: () => req('/ontology/hierarchy'),

  getSuperclasses: (uri) =>
    req(`/ontology/superclasses?uri=${encodeURIComponent(uri)}`),

  getSubclasses: (uri) =>
    req(`/ontology/subclasses?uri=${encodeURIComponent(uri)}`),

  getNamespaces: () => req('/ontology/namespaces'),

  // ── Graph import (existing RDF / Graph-Explorer JSON → canvas model) ──────

  importGraph: (file) => {
    const form = new FormData()
    form.append('file', file)
    return req('/import/graph', { method: 'POST', body: form })
  },

  // ── Export ────────────────────────────────────────────────────────────────

  // `languages` = { primary, additional[] }. The TSV carries the additional
  // languages in `<column>@<tag>` columns; the primary one stays in the plain
  // column and is named here, because a language tag applies to the whole
  // export rather than to a single row.
  exportRdf: (uriTsv, literalTsv, format, languages) =>
    req('/pipeline/rdf-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri_tsv: uriTsv,
        literal_tsv: literalTsv || '',
        format: format || 'xml',
        primary_lang: languages?.primary || '',
        additional_langs: languages?.additional || [],
      }),
    }),

  exportGraphExplorerJson: (uriTsv, literalTsv, title, typeColors, typeLabels, edgeLabels, languages) =>
    req('/pipeline/graph-explorer-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri_tsv: uriTsv,
        literal_tsv: literalTsv || '',
        title: title || 'RDF Graph',
        type_colors: typeColors || {},
        type_labels: typeLabels || {},
        edge_labels: edgeLabels || {},
        primary_lang: languages?.primary || '',
        additional_langs: languages?.additional || [],
      }),
    }),
}

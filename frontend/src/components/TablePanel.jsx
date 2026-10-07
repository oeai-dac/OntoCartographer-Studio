import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Upload, Table, X, GripVertical, AlertCircle } from 'lucide-react'
import { matchTableByColumns } from '../utils/projectTables.js'

let tableIdCounter = 1

// ─── CSV parser ──────────────────────────────────────────────────────────────
function parseCSV(text, separator = ',') {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ''))
  const allRows = lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const cells = line.split(separator).map(c => c.trim().replace(/^"|"$/g, ''))
      const row = {}
      headers.forEach((h, i) => { row[h] = cells[i] ?? '' })
      return row
    })
  return { headers, rows: allRows.slice(0, 10), allRows }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

// META_KEYS: keys that describe *fields* rather than *being* field values.
// When extracting leaf fields from a schema-style JSON, rows whose only
// keys are in this set are skipped (they are schema annotations, not data).
const META_KEYS = new Set(['typ', 'type', 'format', 'hinweis', 'note', 'required', 'pattern', 'minimum', 'maximum', 'enum'])

/**
 * MODE: "records"
 * Classic array-of-objects (or wrapped array). Each object becomes one row.
 * One level of nesting is flattened: { a: { b: 1 } } → { "a.b": "1" }
 */
function parseJsonRecords(parsed) {
  let records = []
  if (Array.isArray(parsed)) {
    records = parsed.map(item =>
      (item !== null && typeof item === 'object' && !Array.isArray(item)) ? item : { value: item }
    )
  } else if (parsed !== null && typeof parsed === 'object') {
    const wrapperKeys = ['data', 'rows', 'items', 'results', 'records', 'features']
    const found = wrapperKeys.find(k => Array.isArray(parsed[k]))
    if (found) {
      records = parsed[found].map(item =>
        (item !== null && typeof item === 'object' && !Array.isArray(item)) ? item : { value: item }
      )
    } else {
      records = Object.entries(parsed).map(([k, v]) => ({ key: k, value: JSON.stringify(v) }))
    }
  }

  const flattenRow = (row) => {
    const flat = {}
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          flat[`${k}.${k2}`] = v2 == null ? '' : String(v2)
        }
      } else {
        flat[k] = v == null ? '' : (Array.isArray(v) ? JSON.stringify(v) : String(v))
      }
    }
    return flat
  }

  const flatRows = records.map(flattenRow)
  const headerSet = new Set()
  flatRows.forEach(r => Object.keys(r).forEach(k => headerSet.add(k)))
  const headers = Array.from(headerSet)
  const allRows = flatRows.map(r => {
    const obj = {}
    headers.forEach(h => { obj[h] = r[h] ?? '' })
    return obj
  })
  return { headers, rows: allRows.slice(0, 10), allRows }
}

/**
 * MODE: "schema"
 * Recursively walks the JSON tree and collects individual field definitions.
 *
 * A "field definition" is an object that contains at least one of the
 * canonical annotation keys (label, beschreibung, description, title, typ,
 * type) alongside an identifier key. Each field becomes ONE row.
 *
 * The columns are: gruppe (path), feldname (key), + all annotation values.
 *
 * For groups whose children are NOT field definitions (i.e. plain data
 * objects), the group itself becomes a single row with its keys as columns
 * — this handles arbitrary schema shapes generically.
 */
function parseJsonSchema(parsed) {
  const rows = []

  // Keys that indicate "this object is a field definition"
  const FIELD_DEF_KEYS = new Set(['label', 'beschreibung', 'description', 'title', 'typ', 'type'])

  function isFieldDef(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false
    return Object.keys(obj).some(k => FIELD_DEF_KEYS.has(k))
  }

  function extractFieldRow(fieldKey, fieldObj, groupPath) {
    // Build a flat row: gruppe + feldname + all annotation values (skip nested objects except struktur-style)
    const row = {
      gruppe: groupPath,
      feldname: fieldKey,
    }
    for (const [k, v] of Object.entries(fieldObj)) {
      if (META_KEYS.has(k)) continue // skip typ/format/hinweis as columns (they're noise for mapping)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        row[k] = JSON.stringify(v)
      } else if (Array.isArray(v)) {
        row[k] = JSON.stringify(v)
      } else {
        row[k] = v == null ? '' : String(v)
      }
    }
    return row
  }

  function walk(node, pathParts) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return

    const childEntries = Object.entries(node).filter(([k]) => !META_KEYS.has(k))
    const childObjects = childEntries.filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))

    // Case 1: children are field definitions → each child = one row
    if (childObjects.length > 0 && childObjects.every(([, v]) => isFieldDef(v))) {
      const groupPath = pathParts.join(' › ') || '—'
      childObjects.forEach(([k, v]) => {
        rows.push(extractFieldRow(k, v, groupPath))
      })
      return
    }

    // Case 2: mixed or deeper nesting → recurse into object children
    for (const [k, v] of childEntries) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        walk(v, [...pathParts, k])
      }
    }

    // Case 3: no object children at all → this node itself is a leaf field, emit as row
    if (childObjects.length === 0 && isFieldDef(node)) {
      const parentPath = pathParts.slice(0, -1).join(' › ') || '—'
      const fieldKey = pathParts[pathParts.length - 1] || '—'
      rows.push(extractFieldRow(fieldKey, node, parentPath))
    }
  }

  walk(parsed, [])

  if (rows.length === 0) return null

  // Collect all headers (union), keeping gruppe + feldname first
  const headerSet = new Set(['gruppe', 'feldname'])
  rows.forEach(r => Object.keys(r).forEach(k => headerSet.add(k)))
  const headers = Array.from(headerSet)
  const allRows = rows.map(r => {
    const obj = {}
    headers.forEach(h => { obj[h] = r[h] ?? '' })
    return obj
  })
  return { headers, rows: allRows.slice(0, 10), allRows }
}

// ─── Draggable column header ──────────────────────────────────────────────────
function DraggableColumnHeader({ name, index, tableId, tableName, allRows }) {
  const handleDragStart = (e) => {
    // tableName travels with the column so the node remembers which file its
    // rows came from: that name is what a later session matches an uploaded
    // file against when it re-fills the project's table placeholders.
    e.dataTransfer.setData('application/column', JSON.stringify({ name, index, tableId, tableName, allRows }))
    e.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <th
      draggable
      onDragStart={handleDragStart}
      style={{
        padding: '6px 10px', textAlign: 'left',
        fontFamily: 'var(--mono)', fontSize: 10,
        color: 'var(--accent)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)',
        cursor: 'grab', whiteSpace: 'nowrap', userSelect: 'none',
        position: 'sticky', top: 0, zIndex: 1,
      }}
      title="Drag onto node: upper half = Label, lower half = ID"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <GripVertical size={9} color="var(--text-muted)" />
        {name}
      </div>
    </th>
  )
}

// ─── JSON Mode Modal ──────────────────────────────────────────────────────────
function JsonModeModal({ fileName, onConfirm, onCancel }) {
  const [mode, setMode] = useState('records')

  const descriptions = {
    records: {
      title: 'Records',
      icon: '⊞',
      detail: 'Array of objects – each object becomes one row.',
      example: '[{ "SU": "003", "Site": "Engelhartstetten" }, …]',
      hint: 'For exported databases, API responses, find lists etc.',
    },
    schema: {
      title: 'Schema / Form',
      icon: '⊟',
      detail: 'Nested field definitions – each leaf field becomes one column.',
      example: '{ "fields": { "header": { "Mnr": { "label": "…", "type": "string" } } } }',
      hint: 'For form schemas, data models, ontology structures etc.',
    },
  }

  const d = descriptions[mode]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '24px 28px',
        width: 420,
        boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 4 }}>
            JSON Import
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            {fileName}
          </div>
        </div>

        {/* Mode selector */}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          How should this JSON file be interpreted?
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          {Object.entries(descriptions).map(([key, desc]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 7,
                border: `1.5px solid ${mode === key ? 'var(--accent)' : 'var(--border)'}`,
                background: mode === key ? 'var(--accent-glow)' : 'var(--bg-card)',
                color: mode === key ? 'var(--accent)' : 'var(--text-muted)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: 16, marginBottom: 4 }}>{desc.icon}</div>
              <div style={{ fontSize: 11, fontWeight: 600 }}>{desc.title}</div>
            </button>
          ))}
        </div>

        {/* Detail box */}
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '12px 14px',
          marginBottom: 20,
          fontSize: 11,
        }}>
          <div style={{ color: 'var(--text)', marginBottom: 6 }}>{d.detail}</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: 'var(--accent)', background: 'var(--bg-panel)',
            borderRadius: 4, padding: '5px 8px', marginBottom: 8,
            wordBreak: 'break-all',
          }}>
            {d.example}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{d.hint}</div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '7px 16px', borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'none', color: 'var(--text-muted)',
              fontSize: 11, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(mode)}
            style={{
              padding: '7px 20px', borderRadius: 6,
              border: 'none',
              background: 'var(--accent)', color: 'var(--bg)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Import →
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function TablePanel({ onAllRowsUpdate, onTableRefresh, onTablesChange, onUseStoredRows, onAssignTable }) {
  const [tables, setTables] = useState([])
  const [activeTable, setActiveTable] = useState(0)
  // pending JSON files waiting for mode selection
  const [pendingJson, setPendingJson] = useState(null) // { files: [...], parsed: [...] }

  // Every file written from the canvas takes its rows from here, so the App
  // needs to know what is loaded at any moment — not only what was loaded
  // while a column was being dragged.
  const tablesRef = useRef([])
  const onTableRefreshRef = useRef(onTableRefresh)
  onTableRefreshRef.current = onTableRefresh
  useEffect(() => {
    tablesRef.current = tables
    onTablesChange?.(tables)
  }, [tables, onTablesChange])

  const processJsonFile = useCallback(async (file) => {
    const text = await file.text()
    return { file, parsed: JSON.parse(text) }
  }, [])

  // Replaces an existing table entry in place (same tableId) instead of appending a duplicate.
  const applyRefresh = useCallback((tableEntry) => {
    setTables(ts => {
      const updated = [...ts]
      const idx = updated.findIndex(t => t.tableId === tableEntry.tableId)
      if (idx >= 0) updated[idx] = tableEntry
      setActiveTable(idx >= 0 ? idx : updated.length - 1)
      return updated
    })
    onTableRefresh?.(tableEntry.tableId, tableEntry.allRows, tableEntry.headers, tableEntry.name)
  }, [onTableRefresh])

  // Tables that did not come from this panel's own upload: synthesised by the
  // graph import, or taken out of a project file on request (App dispatches
  // both). They behave exactly like uploaded ones — their columns can be
  // dragged onto further nodes — and they replace an entry of the same id
  // (a placeholder, or an earlier import) instead of stacking duplicates.
  useEffect(() => {
    const handler = (e) => {
      const incoming = e.detail || []
      if (!incoming.length) return
      // A restored project brings its own "tbl_N" ids back, minted by an
      // earlier session's counter. Without moving the counter past them, the
      // next upload would mint an id that already exists and silently replace
      // the restored table instead of adding its own.
      for (const t of incoming) {
        const m = /^tbl_(\d+)$/.exec(t.tableId || '')
        if (m) tableIdCounter = Math.max(tableIdCounter, Number(m[1]) + 1)
      }
      setTables(ts => {
        const merged = [...ts]
        for (const t of incoming) {
          const idx = merged.findIndex(x => x.tableId === t.tableId)
          if (idx >= 0) merged[idx] = t
          else merged.push(t)
        }
        return merged
      })
      setActiveTable(0)
    }
    window.addEventListener('tables:import', handler)
    return () => window.removeEventListener('tables:import', handler)
  }, [])

  // A loaded project does NOT bring its tables back as data — the rows in the
  // file are last session's snapshot, and the usual reason to re-open a
  // project is to feed it an updated file. It brings placeholders instead:
  // one empty tab per table the canvas refers to, holding that table's id.
  // Loading a file into such a tab reuses the id, so every column mapping on
  // the canvas stays valid and the fresh rows reach the nodes at once.
  useEffect(() => {
    const handler = (e) => {
      const stubs = e.detail || []
      // A project that maps no table at all leaves the panel alone — there is
      // nothing to place, and throwing away what is loaded would only cost the
      // user an upload.
      if (stubs.length === 0) return

      // The stub ids were minted by an earlier session's counter; without
      // moving ours past them the next upload would mint a colliding id.
      for (const t of stubs) {
        const m = /^tbl_(\d+)$/.exec(t.tableId || '')
        if (m) tableIdCounter = Math.max(tableIdCounter, Number(m[1]) + 1)
      }

      const loadedBefore = tablesRef.current.filter(t => !t.pending && t.allRows?.length > 0)
      const adopted = new Set()
      const next = stubs.map(stub => {
        // A table already loaded under the same file name is the one the
        // placeholder is asking for — keep its rows instead of emptying the
        // panel. Matching on the id alone would not do: ids are handed out by
        // a per-session counter, so the "tbl_3" of two projects are unrelated.
        const loaded = loadedBefore.find(t => t.name && t.name === stub.name && !adopted.has(t))
        if (!loaded) return { ...stub }
        adopted.add(loaded)
        return { ...loaded, tableId: stub.tableId }
      })

      // Tables the project does not know stay available — they belong to no
      // node on the new canvas, but their columns can be dragged onto one.
      // Their old id may well be one the new project uses for something else,
      // so they are given a fresh one.
      const stubIds = new Set(stubs.map(s => s.tableId))
      for (const t of loadedBefore) {
        if (adopted.has(t)) continue
        next.push(stubIds.has(t.tableId) ? { ...t, tableId: `tbl_${tableIdCounter++}` } : t)
      }

      setTables(next)
      setActiveTable(0)
      // The adopted tables are newer than the project's snapshot, so their
      // rows go straight into the freshly loaded nodes.
      for (const t of next) {
        if (!t.pending && stubIds.has(t.tableId)) {
          onTableRefreshRef.current?.(t.tableId, t.allRows, t.headers, t.name)
        }
      }
    }
    window.addEventListener('tables:placeholders', handler)
    return () => window.removeEventListener('tables:placeholders', handler)
  }, [])

  // Column-signature matching for a file the panel cannot recognise by name
  // (see matchTableByColumns); `claimed` holds the ids other files of the same
  // upload already took.
  const matchPendingByColumns = useCallback((headers, claimed) => {
    return matchTableByColumns(headers, tables.filter(t => t.pending && !claimed.has(t.tableId)))
  }, [tables])

  /**
   * @param e              the file input change event
   * @param targetTableId  set when the file is loaded into one specific table
   *                       (a project placeholder, or a re-load from the tab):
   *                       the entry keeps that id whatever the file is called,
   *                       which is what re-binds it to the mapped nodes.
   */
  const handleFileUpload = useCallback(async (e, targetTableId = null) => {
    const files = Array.from(e.target.files)
    e.target.value = ''

    const newTables = []
    const refreshedTables = []
    const jsonFiles = []
    const claimed = new Set()

    // Into a named slot, or — for a plain upload — onto the table of the same
    // file name, or onto the placeholder whose columns the file matches: all
    // three keep the existing tableId, which is what re-binds the mapped
    // nodes. Only a file that fits nowhere becomes a table of its own.
    const bindingFor = (file, headers) => {
      const found = targetTableId
        ? tables.find(t => t.tableId === targetTableId)
        : (tables.find(t => t.name === file.name && !claimed.has(t.tableId))
           || matchPendingByColumns(headers, claimed))
      if (found) claimed.add(found.tableId)
      return found || null
    }

    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase()

      if (ext === 'csv' || ext === 'tsv') {
        const sep = ext === 'tsv' ? '\t' : ','
        const text = await file.text()
        const parsed = parseCSV(text, sep)
        const existing = bindingFor(file, parsed.headers)
        const tableEntry = { name: file.name, tableId: existing ? existing.tableId : `tbl_${tableIdCounter++}`, ...parsed }
        if (existing) refreshedTables.push(tableEntry)
        else newTables.push(tableEntry)

      } else if (ext === 'xlsx' || ext === 'xls') {
        try {
          const XLSX = await import('xlsx')
          const buf = await file.arrayBuffer()
          const wb = XLSX.read(buf)
          const ws = wb.Sheets[wb.SheetNames[0]]
          const data = XLSX.utils.sheet_to_json(ws, { header: 1 })
          const headers = (data[0] || []).map(String)
          const allRows = data.slice(1).filter(r => r.some(v => v != null && v !== '')).map(row => {
            const obj = {}
            headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
            return obj
          })
          const existing = bindingFor(file, headers)
          const tableEntry = {
            name: file.name, tableId: existing ? existing.tableId : `tbl_${tableIdCounter++}`,
            headers, rows: allRows.slice(0, 10), allRows,
          }
          if (existing) refreshedTables.push(tableEntry)
          else newTables.push(tableEntry)
        } catch (err) {
          console.error('XLSX parse error:', err)
        }

      } else if (ext === 'json') {
        try {
          // The columns are only known once the interpretation mode is picked,
          // so this one is bound in handleJsonModeConfirm.
          const { parsed } = await processJsonFile(file)
          jsonFiles.push({ file, parsed, targetTableId })
        } catch (err) {
          console.error('JSON parse error:', err)
        }
      }
    }

    // Add non-JSON tables immediately
    if (newTables.length > 0) {
      setTables(ts => {
        const updated = [...ts, ...newTables]
        const last = newTables[newTables.length - 1]
        if (last) onAllRowsUpdate?.(last.allRows)
        setActiveTable(updated.length - 1)
        return updated
      })
    }

    // Re-uploaded tables: replace in place + push fresh rows into already-mapped nodes
    refreshedTables.forEach(applyRefresh)

    // Show modal for JSON files (one at a time, sequentially)
    if (jsonFiles.length > 0) {
      setPendingJson(jsonFiles)
    }
  }, [onAllRowsUpdate, processJsonFile, tables, applyRefresh, matchPendingByColumns])

  const handleJsonModeConfirm = useCallback((mode) => {
    if (!pendingJson || pendingJson.length === 0) return

    const { file, parsed, targetTableId } = pendingJson[0]
    let result = null

    if (mode === 'schema') {
      result = parseJsonSchema(parsed)
      if (!result) {
        console.warn('JSON schema parse: no leaf fields found, falling back to records mode')
        result = parseJsonRecords(parsed)
      }
    } else {
      result = parseJsonRecords(parsed)
    }

    if (result && result.headers.length > 0) {
      // Same binding rules as every other format — only now, after the mode
      // decided what the columns are.
      const existing = targetTableId
        ? tables.find(t => t.tableId === targetTableId)
        : (tables.find(t => t.name === file.name) || matchPendingByColumns(result.headers, new Set()))
      const tableEntry = {
        name: file.name,
        tableId: existing ? existing.tableId : `tbl_${tableIdCounter++}`,
        ...result,
      }
      if (existing) {
        applyRefresh(tableEntry)
      } else {
        setTables(ts => {
          const updated = [...ts, tableEntry]
          onAllRowsUpdate?.(tableEntry.allRows)
          setActiveTable(updated.length - 1)
          return updated
        })
      }
    }

    // Move to next pending JSON, or clear
    const remaining = pendingJson.slice(1)
    setPendingJson(remaining.length > 0 ? remaining : null)
  }, [pendingJson, onAllRowsUpdate, applyRefresh, tables, matchPendingByColumns])

  const handleJsonModeCancel = useCallback(() => {
    // Skip current file, proceed with remaining
    const remaining = pendingJson?.slice(1)
    setPendingJson(remaining?.length > 0 ? remaining : null)
  }, [pendingJson])

  const removeTable = (idx) => {
    setTables(ts => ts.filter((_, i) => i !== idx))
    setActiveTable(prev => Math.max(0, prev - (idx <= prev ? 1 : 0)))
  }

  const current = tables[activeTable]
  // Tables that actually hold data — what a placeholder can be pointed at.
  const loadedTables = tables.filter(t => !t.pending && t.allRows?.length > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Modal */}
      {pendingJson && pendingJson.length > 0 && (
        <JsonModeModal
          fileName={pendingJson[0].file.name}
          onConfirm={handleJsonModeConfirm}
          onCancel={handleJsonModeCancel}
        />
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <Table size={12} color="var(--text-muted)" />
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', flex: 1 }}>
          Tables
        </span>
        <label style={{ cursor: 'pointer' }}>
          <input type="file" accept=".csv,.tsv,.xlsx,.xls,.json" multiple style={{ display: 'none' }} onChange={handleFileUpload} />
          <div className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '3px 8px' }}>
            <Upload size={10} /> Load
          </div>
        </label>
      </div>

      {tables.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>
          Load CSV / TSV / XLSX / JSON
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 2, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            {tables.map((t, i) => (
              <div key={t.tableId} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 8px', borderRadius: 'var(--radius)',
                background: i === activeTable ? 'var(--accent-glow)' : 'var(--bg-card)',
                // A placeholder is drawn as an outline: it is a table the
                // project expects, not one that holds data.
                border: `1px ${t.pending ? 'dashed' : 'solid'} ${i === activeTable ? 'var(--accent-dim)' : 'var(--border)'}`,
                cursor: 'pointer', fontSize: 10,
                color: i === activeTable ? 'var(--accent)' : 'var(--text-muted)',
              }} onClick={() => setActiveTable(i)}
                title={t.pending ? 'No data loaded — open the tab to load the file for this table' : t.name}
              >
                {t.pending && <AlertCircle size={9} />}
                <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: t.pending ? 'italic' : 'normal' }}>{t.name}</span>
                <X size={9} onClick={(e) => { e.stopPropagation(); removeTable(i) }} style={{ cursor: 'pointer' }} />
              </div>
            ))}
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 12px', fontSize: 9, color: 'var(--text-muted)',
            borderBottom: '1px solid var(--border)', background: 'var(--bg-card)',
          }}>
            {current?.pending ? (
              <span style={{ flex: 1 }}>⚠ Expected by the loaded project · no data yet</span>
            ) : current && (
              <>
                <span style={{ flex: 1 }}>
                  ⠿ Drag column headers onto nodes · {current.headers.length} columns · {current.allRows.length} rows
                </span>
                {/* Re-loading through the tab keeps the table id whatever the
                    file is called, so the mapped nodes follow the new rows. */}
                <label style={{ cursor: 'pointer', color: 'var(--accent)', whiteSpace: 'nowrap' }}
                  title="Load this table again from file — mappings are kept, the new rows are used by every export">
                  <input type="file" accept=".csv,.tsv,.xlsx,.xls,.json" style={{ display: 'none' }}
                    onChange={(e) => handleFileUpload(e, current.tableId)} />
                  ↻ Reload
                </label>
              </>
            )}
          </div>

          {current?.pending && (
            <div style={{ flex: 1, overflow: 'auto', padding: 16, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <div style={{ color: 'var(--text)', marginBottom: 8 }}>
                Table “{current.name}” holds no data.
              </div>
              <div>
                Referenced by {current.nodeCount || 0} node{current.nodeCount === 1 ? '' : 's'} of the loaded project
                {current.storedRowCount > 0 && (
                  <> · {current.storedRowCount} {current.storedRowCount === 1 ? 'row' : 'rows'} / {current.headers.length} {current.headers.length === 1 ? 'column' : 'columns'} stored in the file</>
                )}
              </div>

              {/* Which node reads what — the surest way to tell an unnamed
                  table of an older project apart from its own newer version. */}
              {current.nodeUses?.length > 0 && (
                <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px' }}>
                  {current.nodeUses.slice(0, 8).map((u, i) => (
                    <li key={i} style={{ fontSize: 10 }}>
                      {u.label}
                      {u.mappedColumn && <> — ID <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{u.mappedColumn}</span></>}
                      {u.labelColumn && <>, Label <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{u.labelColumn}</span></>}
                    </li>
                  ))}
                  {current.nodeUses.length > 8 && (
                    <li style={{ fontSize: 10, fontStyle: 'italic' }}>… {current.nodeUses.length - 8} more</li>
                  )}
                </ul>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', marginTop: 14 }}>
                <label style={{ cursor: 'pointer' }}>
                  <input type="file" accept=".csv,.tsv,.xlsx,.xls,.json" style={{ display: 'none' }}
                    onChange={(e) => handleFileUpload(e, current.tableId)} />
                  <div className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, padding: '4px 10px' }}>
                    <Upload size={10} /> Load file for this table
                  </div>
                </label>
                {current.storedRowCount > 0 && (
                  <button className="btn-secondary" style={{ fontSize: 10, padding: '4px 10px' }}
                    onClick={() => onUseStoredRows?.(current.tableId)}
                    title="Take the rows the project file carries in its nodes — the state of the data when the project was saved">
                    Use the {current.storedRowCount} {current.storedRowCount === 1 ? 'row' : 'rows'} stored in the project
                  </button>
                )}
                {/* An old version of a table left its id on the nodes that were
                    mapped before it was replaced; this points them at the table
                    that is already loaded instead. */}
                {loadedTables.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                    or use a loaded table:
                    <select value="" style={{ fontSize: 10, padding: '3px 6px' }}
                      onChange={(e) => {
                        const target = loadedTables.find(t => t.tableId === e.target.value)
                        if (!target) return
                        onAssignTable?.(current.tableId, target)
                        removeTable(activeTable)
                      }}
                      title="Re-point every node of this placeholder to an already loaded table — for a table that was replaced by a newer version under a different name">
                      <option value="">choose…</option>
                      {loadedTables.map(t => (
                        <option key={t.tableId} value={t.tableId}>{t.name} ({t.allRows.length} {t.allRows.length === 1 ? 'row' : 'rows'})</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div style={{ marginTop: 14, fontSize: 10, fontStyle: 'italic' }}>
                Whatever is loaded here keeps this table’s id, so every column mapping on the
                canvas stays valid and added, changed or deleted rows end up in the next export.
              </div>

              {current.sampleRows?.length > 0 && (
                <>
                  <div style={{ marginTop: 16, marginBottom: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Stored in the project · first {current.sampleRows.length} {current.sampleRows.length === 1 ? 'row' : 'rows'}
                  </div>
                  <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 10 }}>
                      <thead>
                        <tr>
                          {current.headers.map((h, i) => (
                            <th key={i} style={{
                              padding: '4px 8px', textAlign: 'left', whiteSpace: 'nowrap',
                              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 500,
                              color: current.usedColumns?.includes(h) ? 'var(--accent)' : 'var(--text-muted)',
                              borderBottom: '1px solid var(--border)', background: 'var(--bg-card)',
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {current.sampleRows.map((row, ri) => (
                          <tr key={ri} style={{ borderBottom: '1px solid var(--border)' }}>
                            {current.headers.map((h, ci) => (
                              <td key={ci} style={{
                                padding: '3px 8px', color: 'var(--text-dim)',
                                fontFamily: 'var(--mono)', fontSize: 9,
                                maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>{String(row[h] ?? '')}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {current && !current.pending && (
            <div style={{ flex: 1, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    {current.headers.map((h, i) => (
                      <DraggableColumnHeader
                        key={i} name={h} index={i}
                        tableId={current.tableId}
                        tableName={current.name}
                        allRows={current.allRows}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.rows.map((row, ri) => (
                    <tr key={ri} style={{ borderBottom: '1px solid var(--border)' }}>
                      {current.headers.map((h, ci) => (
                        <td key={ci} style={{
                          padding: '5px 10px', color: 'var(--text-dim)',
                          fontFamily: 'var(--mono)', fontSize: 10,
                          maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {String(row[h] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

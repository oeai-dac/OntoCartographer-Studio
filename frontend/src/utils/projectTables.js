/**
 * projectTables.js — table bookkeeping around a loaded project.
 *
 * A project file carries its table data inside the nodes (`data.tableRows`,
 * written on every column drop) and, from v5 on, a top-level `tables` section
 * with the metadata (name, headers, row count) of every table the canvas
 * references.
 *
 * Loading a project deliberately does NOT refill the table panel: the rows in
 * the file are a snapshot of an earlier session, and a project is usually
 * re-opened in order to feed it *updated* tables. What the panel gets instead
 * are placeholders (`tableStubsFromProject`) — one per referenced table,
 * carrying the very id the nodes are mapped to, so the file the user loads
 * into a placeholder binds to exactly those nodes without re-dragging a single
 * column. `tablesFromNodes` is still available, behind the placeholder's
 * "use the rows stored in the project" button.
 *
 * Writing files goes the other way round: `withLiveRows` replaces every node's
 * stored snapshot with the rows currently in the panel, so the project file,
 * the Graph Explorer JSON and the RDF always describe the data as it is loaded
 * right now — including rows added, changed or deleted since the project was
 * saved.
 */

/**
 * Groups the nodes of a loaded project by their tableId and rebuilds the panel
 * entries from the rows the nodes carry.
 *
 * Only used on explicit request now (placeholder → "use stored rows"); the
 * project load itself hands out placeholders instead.
 *
 * @param {Array} nodes  ReactFlow nodes of a project file
 * @returns {Array} [{ name, tableId, headers, rows, allRows }]
 */
export function tablesFromNodes(nodes) {
  const byId = new Map()

  for (const node of nodes || []) {
    const d = node?.data
    const tableId = d?.tableId
    const allRows = d?.tableRows
    if (!tableId || !Array.isArray(allRows) || allRows.length === 0) continue

    const previous = byId.get(tableId)
    // Several nodes share one table. They normally hold the identical array;
    // if an older project has diverging copies, keep the fullest one rather
    // than whichever node happens to come first.
    if (previous && previous.allRows.length >= allRows.length) {
      if (!previous.name && d.tableName) previous.name = d.tableName
      continue
    }
    byId.set(tableId, { tableId, allRows, name: d.tableName || previous?.name || '' })
  }

  return [...byId.values()].map(({ tableId, allRows, name }) => {
    // Column order follows the first row; later rows may carry extra keys
    // (hand-edited projects), and a column missing from the panel cannot be
    // dragged, so union them in.
    const headers = []
    const seen = new Set()
    for (const row of allRows) {
      for (const key of Object.keys(row || {})) {
        if (!seen.has(key)) {
          seen.add(key)
          headers.push(key)
        }
      }
    }
    return {
      name: name || tableId,
      tableId,
      headers,
      rows: allRows.slice(0, 10),
      allRows,
    }
  })
}

/**
 * Describes every table a loaded project refers to, without its data.
 *
 * The panel shows one placeholder per entry; loading a file into it reuses the
 * `tableId`, which is what keeps the existing column mappings alive. The
 * bookkeeping fields (`usedColumns`, `nodeCount`, `storedRowCount`) are there
 * so the placeholders can be told apart — a project saved before v5 holds no
 * table names at all, only ids like "tbl_3".
 *
 * @param {Object} project  the parsed project file
 * @returns {Array} [{ tableId, name, headers, usedColumns, nodeCount, storedRowCount, pending, rows, allRows }]
 */
export function tableStubsFromProject(project) {
  const meta = new Map()
  for (const t of project?.tables || []) {
    if (!t?.tableId) continue
    meta.set(t.tableId, {
      name: t.name || '',
      headers: Array.isArray(t.headers) ? [...t.headers] : [],
    })
  }

  const byId = new Map()
  const entryFor = (tableId) => {
    let entry = byId.get(tableId)
    if (!entry) {
      const m = meta.get(tableId)
      entry = {
        tableId,
        name: m?.name || '',
        headers: m?.headers ? [...m.headers] : [],
        usedColumns: [],
        nodeUses: [],
        sampleRows: [],
        nodeCount: 0,
        storedRowCount: 0,
      }
      byId.set(tableId, entry)
    }
    return entry
  }

  const addColumn = (entry, col) => {
    if (col && !entry.usedColumns.includes(col)) entry.usedColumns.push(col)
  }

  const tableOfNode = new Map()
  for (const node of project?.nodes || []) {
    const d = node?.data
    const tableId = d?.tableId
    if (!tableId) continue
    tableOfNode.set(node.id, tableId)

    const entry = entryFor(tableId)
    entry.nodeCount++
    if (!entry.name && d.tableName) entry.name = d.tableName
    addColumn(entry, d.mappedColumn)
    addColumn(entry, d.labelColumn)
    // Which node uses the table for what: a project saved before v5 carries no
    // table names at all, and "E22_Human-Made_Object takes its id from
    // OR_INVENTARNUMMER here" is what actually identifies the file.
    entry.nodeUses.push({
      label: d.label || node.id,
      mappedColumn: d.mappedColumn || '',
      labelColumn: d.labelColumn || '',
    })

    const rows = d.tableRows
    if (Array.isArray(rows) && rows.length > 0) {
      if (rows.length > entry.storedRowCount) {
        entry.storedRowCount = rows.length
        // A glance at the stored data says more than any name — kept short,
        // the full set is one click away.
        entry.sampleRows = rows.slice(0, 5)
      }
      // Headers of a pre-v5 project can only come from the stored rows.
      for (const key of Object.keys(rows[0])) {
        if (!entry.headers.includes(key)) entry.headers.push(key)
      }
    }
  }

  // Join keys live on the edge, not on the node, but they belong to the table
  // of the node they are read from — and they are often the one column that
  // tells which file a placeholder is waiting for.
  for (const edge of project?.edges || []) {
    const d = edge?.data
    if (!d) continue
    const srcTable = tableOfNode.get(edge.source)
    const tgtTable = tableOfNode.get(edge.target)
    if (srcTable && d.joinColumnSource) addColumn(entryFor(srcTable), d.joinColumnSource)
    if (tgtTable && (d.joinColumnTarget || d.joinColumn)) {
      addColumn(entryFor(tgtTable), d.joinColumnTarget || d.joinColumn)
    }
  }

  return [...byId.values()].map(entry => ({
    ...entry,
    name: entry.name || entry.tableId,
    headers: entry.headers.length > 0 ? entry.headers : [...entry.usedColumns],
    pending: true,
    rows: [],
    allRows: [],
  }))
}

/**
 * Finds the placeholder a freshly parsed file belongs to, by its columns.
 *
 * A project saved before v5 knows no table names, so a file dropped on the
 * panel cannot be recognised by its name. Its columns give it away instead:
 * the same table exports the same header set however many rows were added or
 * deleted in between. Only an unambiguous match binds — anything else leaves
 * the placeholders alone, to be filled from their own tab.
 *
 * @param {Array} headers     the columns of the parsed file
 * @param {Array} candidates  the placeholders still waiting for data
 * @returns {Object|null} the matching placeholder
 */
export function matchTableByColumns(headers, candidates) {
  const open = (candidates || []).filter(t => t?.headers?.length > 0)
  if (open.length === 0 || !headers?.length) return null
  const fileColumns = new Set(headers)

  const sameSet = open.filter(t =>
    t.headers.length === headers.length && t.headers.every(h => fileColumns.has(h)))
  if (sameSet.length === 1) return sameSet[0]
  if (sameSet.length > 1) return null

  // A column was added or dropped since the project was saved: still the same
  // table when every mapped column is there and most of the old ones are, and
  // when no second placeholder fits equally well.
  const partial = open.filter(t => {
    const used = t.usedColumns || []
    if (used.length === 0 || !used.every(c => fileColumns.has(c))) return false
    const kept = t.headers.filter(h => fileColumns.has(h)).length
    return kept >= Math.ceil(t.headers.length / 2)
  })
  return partial.length === 1 ? partial[0] : null
}

/**
 * Puts the rows currently loaded in the table panel into the nodes.
 *
 * Every exporter reads its rows off the node, so this is the single place that
 * decides what "the current data" means when a file is written: a node whose
 * table is loaded gets that table's rows (added, changed and deleted entries
 * included), a node whose table is not loaded keeps the snapshot from the
 * project and is reported in `missing`, so the caller can say so.
 *
 * @param {Array} nodes       ReactFlow nodes
 * @param {Array} liveTables  the panel's current tables
 * @returns {{ nodes: Array, missing: Array, refreshed: Array }}
 */
export function withLiveRows(nodes, liveTables) {
  const live = new Map()
  for (const t of liveTables || []) {
    if (!t?.tableId || t.pending || !Array.isArray(t.allRows)) continue
    live.set(t.tableId, t)
  }

  const missing = new Map()
  const refreshed = new Map()

  const out = (nodes || []).map(node => {
    const d = node?.data
    const tableId = d?.tableId
    if (!tableId) return node

    const table = live.get(tableId)
    if (!table) {
      const entry = missing.get(tableId) || {
        tableId,
        name: d.tableName || tableId,
        nodeCount: 0,
        storedRowCount: Array.isArray(d.tableRows) ? d.tableRows.length : 0,
      }
      entry.nodeCount++
      missing.set(tableId, entry)
      return node
    }

    if (!refreshed.has(tableId)) {
      refreshed.set(tableId, {
        tableId,
        name: table.name || tableId,
        rowCount: table.allRows.length,
        previousRowCount: Array.isArray(d.tableRows) ? d.tableRows.length : 0,
      })
    }

    if (d.tableRows === table.allRows && d.tableName === table.name) return node
    return {
      ...node,
      data: { ...d, tableRows: table.allRows, tableName: table.name || d.tableName },
    }
  })

  return { nodes: out, missing: [...missing.values()], refreshed: [...refreshed.values()] }
}

/**
 * The `tables` section of a saved project: what the placeholders of the next
 * session are built from. Metadata only — the rows themselves stay in the
 * nodes, where every exporter reads them.
 *
 * @param {Array} nodes       nodes as they go into the file (after `withLiveRows`)
 * @param {Array} liveTables  the panel's current tables
 * @returns {Array} [{ tableId, name, headers, rowCount }]
 */
export function tableMetaForProject(nodes, liveTables) {
  const byId = new Map()

  for (const node of nodes || []) {
    const d = node?.data
    const tableId = d?.tableId
    if (!tableId) continue

    let entry = byId.get(tableId)
    if (!entry) {
      entry = { tableId, name: d.tableName || '', headers: [], rowCount: 0 }
      byId.set(tableId, entry)
    }
    if (!entry.name && d.tableName) entry.name = d.tableName

    const rows = d.tableRows
    if (Array.isArray(rows) && rows.length > 0) {
      if (rows.length > entry.rowCount) entry.rowCount = rows.length
      if (entry.headers.length === 0) entry.headers = Object.keys(rows[0])
    }
  }

  // The panel knows the real file name and the full header list, including
  // columns no node happens to be mapped to.
  for (const t of liveTables || []) {
    if (!t?.tableId || t.pending) continue
    const entry = byId.get(t.tableId)
    if (!entry) continue
    if (t.name) entry.name = t.name
    if (Array.isArray(t.headers) && t.headers.length > 0) entry.headers = [...t.headers]
    if (Array.isArray(t.allRows)) entry.rowCount = t.allRows.length
  }

  return [...byId.values()].map(e => ({ ...e, name: e.name || e.tableId }))
}

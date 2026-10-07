import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import ReactFlow, {
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from 'reactflow'
import 'reactflow/dist/style.css'

import OntologyPanel from './components/OntologyPanel.jsx'
import TablePanel from './components/TablePanel.jsx'
import ToastContainer from './components/Toast.jsx'
import PropertyPickerModal from './components/PropertyPickerModal.jsx'
import EdgeEditModal from './components/EdgeEditModal.jsx'
import DotOneModal from './components/DotOneModal.jsx'
import ClassChangeModal from './components/ClassChangeModal.jsx'
import ImportGraphModal from './components/ImportGraphModal.jsx'
import PrefixManagerModal from './components/PrefixManagerModal.jsx'
import LanguageManagerModal from './components/LanguageManagerModal.jsx'
import { nodeTypes } from './components/OntologyNode.jsx'
import { useToast } from './hooks/useToast.js'
import { exportGraphML, exportRdfPipelineTSV, downloadText } from './utils/graphml.js'
import { buildImportedGraph } from './utils/graphImport.js'
import { tablesFromNodes, tableStubsFromProject, withLiveRows, tableMetaForProject } from './utils/projectTables.js'
import { computeCollapse } from './utils/collapse.js'
import {
  DEFAULT_LANGUAGES, normalizeLanguages, allLanguages, isMultilingual,
  patchLangValue, getLangValue, hasLabelIn, hasExplorerLabelIn,
  remapNodeLanguages, langValues,
} from './utils/languages.js'
import { LanguageViewContext } from './hooks/useLanguageView.js'
import { Download, Table, Layers, Save, FolderOpen, ShieldCheck, ChevronsDownUp, X, Group, FileDown, Tag, PlusCircle, ChevronDown, Image, FileInput, Minimize2, Maximize2, Languages } from 'lucide-react'
import { resolveColor } from './utils/cidocColors.js'
import { api } from './utils/api.js'

let nodeCounter = 1

const EDGE_STYLE  = { stroke: '#db2777', strokeWidth: 1.5 }
const EDGE_MARKER = { type: MarkerType.ArrowClosed, color: '#db2777', width: 14, height: 14 }
const EDGE_LABEL_STYLE = {
  labelStyle:      { fill: '#db2777', fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 },
  labelBgStyle:    { fill: '#ffffff', fillOpacity: 0.95 },
  labelBgPadding:  [4, 6],
  labelBgBorderRadius: 3,
}

const DOTONE_EDGE_STYLE  = { stroke: '#db2777', strokeWidth: 1.2, strokeDasharray: '6 3' }
const DOTONE_EDGE_MARKER = { type: MarkerType.ArrowClosed, color: '#db2777', width: 12, height: 12 }
const DOTONE_LABEL_STYLE = {
  labelStyle:      { fill: '#db2777', fontFamily: "'IBM Plex Mono',monospace", fontSize: 9 },
  labelBgStyle:    { fill: '#ffffff', fillOpacity: 0.95 },
  labelBgPadding:  [3, 5],
  labelBgBorderRadius: 3,
}

function makeEdge(id, source, target, prop, sourceHandle, targetHandle) {
  return {
    id,
    source,
    target,
    sourceHandle: sourceHandle || null,
    targetHandle: targetHandle || null,
    label: prop.label,
    data: {
      label: prop.label,
      propertyUri: prop.uri,
      joinColumnSource: prop.joinColumnSource || null,
      joinColumnTarget: prop.joinColumnTarget || null,
    },
    style: EDGE_STYLE,
    markerEnd: EDGE_MARKER,
    ...EDGE_LABEL_STYLE,
  }
}

function makeDotOneEdge(id, midpointId, targetId, propLabel) {
  return {
    id,
    source: midpointId,
    target: targetId,
    sourceHandle: 'dot-s',
    targetHandle: 't-t',
    label: propLabel,
    data: { label: propLabel, isDotOne: true },
    style: DOTONE_EDGE_STYLE,
    markerEnd: DOTONE_EDGE_MARKER,
    ...DOTONE_LABEL_STYLE,
  }
}

const PANEL_ONTOLOGY = 'ontology'
const PANEL_TABLE    = 'table'

// The edge editor is authoritative for every field it submits: a field the
// user deliberately emptied arrives as null or '' and MUST overwrite the
// stored value. Only a genuinely absent field (undefined) falls back to the
// previous one. Using `??` here treats "cleared" as "unset" and silently
// restores the old value, which made an assigned join key impossible to
// remove again once it had been set.
function pickField(next, prev) {
  return next === undefined ? prev : next
}

// Colour heuristic for custom/free classes that are not part of a loaded
// ontology (xsd:* literals, geo:*/GeoSPARQL geometry). The CIDOC superclass
// lookup cannot resolve those, so match on the namespace instead.
// Returns null when the class is an ordinary ontology class.
function freeClassColor(label, uri) {
  const s = `${label || ''} ${uri || ''}`
  if (/(^|\s)xsd:/.test(s) || s.includes('XMLSchema')) return '#86bcc8'
  if (/(^|\s)geo:/.test(s) || s.includes('geosparql')) return '#94cc7d'
  return null
}

function BoundingBoxOverlay({ bounds, color, label, rfInstance }) {
  if (!bounds || !rfInstance) return null
  const vp = rfInstance.getViewport()
  const sx = bounds.x * vp.zoom + vp.x
  const sy = bounds.y * vp.zoom + vp.y
  const sw = bounds.width * vp.zoom
  const sh = bounds.height * vp.zoom
  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 4, overflow: 'visible' }}>
      <rect x={sx} y={sy} width={sw} height={sh} rx={8} fill={color + '0a'} stroke={color} strokeWidth={2} strokeDasharray="8 4" />
      <text x={sx + 8} y={sy - 6} fill={color} fontSize={11} fontFamily="'IBM Plex Mono', monospace" fontWeight={600}>{label}</text>
    </svg>
  )
}

function GraphInner({
  nodes, edges,
  onNodesChange, onEdgesChange,
  setNodes, setEdges,
  toast, tableData,
  activePanel, setActivePanel,
  leftWidth, onMouseDownResize,
  idPrefix, setIdPrefix,
  prefixMap, setPrefixMap,
  widening, setWidening,
  wideningParent, setWideningParent,
  languages, setLanguages,
  activeLang, setActiveLang,
}) {
  const rfInstance   = useReactFlow()
  const rfWrapper    = useRef(null)
  const loadInputRef = useRef(null)
  // What the table panel currently holds. Every file written from the canvas
  // (project, Graph Explorer JSON, RDF) takes its rows from here, so editing a
  // table outside and loading it again is enough to update an export — see
  // `withLiveRows`.
  const [liveTables, setLiveTables] = useState([])
  const [pendingConnect, setPendingConnect] = useState(null)
  const [verifyResults, setVerifyResults] = useState(null)
  const [editingEdge, setEditingEdge] = useState(null)
  const [pendingDotOne, setPendingDotOne] = useState(null)
  const [changingClass, setChangingClass] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const importInputRef = useRef(null)
  const [namedGraphs, setNamedGraphs] = useState([])
  const [showGraphPanel, setShowGraphPanel] = useState(false)
  const [showPrefixManager, setShowPrefixManager] = useState(false)
  const [showLanguageManager, setShowLanguageManager] = useState(false)
  // Read by the three label writers below instead of the `languages` prop.
  // Those writers travel INSIDE the node data (see nodeCallbacks) and are
  // captured once, when a node is created — so a handler that closed over the
  // language set would keep using the one that was current back then. After a
  // change of primary language that is not a stale label, it is a wrong slot:
  // the writer would file English text in the map instead of the flat field.
  // The ref keeps the bundle stable and always current at the same time.
  const languagesRef = useRef(languages)
  useEffect(() => { languagesRef.current = languages }, [languages])
  const [showLangMenu, setShowLangMenu] = useState(false)
  const langMenuRef = useRef(null)
  const [ontologyPrefixes, setOntologyPrefixes] = useState([])
  const [showFreeNode, setShowFreeNode] = useState(false)
  const [freeNodeLabel, setFreeNodeLabel] = useState('')
  const [freeNodeUri, setFreeNodeUri] = useState('')
  const [ngLabel, setNgLabel] = useState('')
  const [highlightNg, setHighlightNg] = useState(null) // { nodeIds, color, bounds }

  const handleDeleteNode = useCallback((id) => {
    setNodes(ns => ns.filter(n => n.id !== id))
    setEdges(es => es.filter(e => e.source !== id && e.target !== id))
  }, [setNodes, setEdges])

  // Both label writers normalise to a trimmed string, so a field the user
  // emptied (or left as whitespace) is stored as '' and every consumer —
  // export, verification, Graph Explorer — sees it as genuinely unset.
  //
  // `lang` names the language the node row was showing. For the primary
  // language `patchLangValue` writes the same flat field these handlers
  // always wrote; only an additional language lands in the sibling map.
  const handleLabelChange = useCallback((id, label, lang) => {
    const value = (label || '').trim()
    setNodes(ns => ns.map(n => n.id === id
      ? { ...n, data: { ...n.data, ...patchLangValue(n.data, 'instanceLabel', lang, value, languagesRef.current) } }
      : n))
  }, [setNodes])

  const handleColumnDrop = useCallback((id, col) => {
    setNodes(ns => ns.map(n => n.id === id ? {
      ...n, data: {
        ...n.data,
        mappedColumn: col ? col.name : null,
        tableId:      col ? col.tableId : null,
        // The file name is what a later session matches a re-loaded table
        // against, so it is kept on the node and saved with the project.
        tableName:    col ? (col.tableName || null) : null,
        tableRows:    col ? col.allRows : null,
      }
    } : n))
    if (col) toast.success(`ID column "${col.name}" assigned (${col.allRows?.length} rows)`)
  }, [setNodes, toast])

  // Called when a table is loaded again under the same filename, re-loaded
  // through its tab, or loaded into one of the placeholders a project leaves
  // behind (see TablePanel). Pushes the fresh rows into every node mapped to
  // that table, so a corrected source file doesn't require re-dragging every
  // column by hand — and every export from here on writes the new rows.
  const handleTableRefresh = useCallback((tableId, allRows, headers, tableName) => {
    let updatedCount = 0
    const missingColumns = new Set()
    setNodes(ns => ns.map(n => {
      if (n.data?.tableId !== tableId) return n
      updatedCount++
      if (headers) {
        if (n.data.mappedColumn && !headers.includes(n.data.mappedColumn)) missingColumns.add(n.data.mappedColumn)
        for (const c of Object.values(langValues(n.data, 'labelColumn', languages))) {
          if (!headers.includes(c)) missingColumns.add(c)
        }
      }
      return { ...n, data: { ...n.data, tableRows: allRows, tableName: tableName || n.data.tableName } }
    }))
    if (updatedCount > 0) {
      toast.success(`Table refreshed — ${updatedCount} node${updatedCount === 1 ? '' : 's'} updated with the new data`)
    }
    if (missingColumns.size > 0) {
      toast.error(`Column(s) no longer found in the refreshed table: "${[...missingColumns].join('", "')}" — check node mapping`)
    }
  }, [setNodes, toast, languages])

  // A placeholder's escape hatch: instead of a file, take the rows the project
  // file carries inside its nodes. Explicit on purpose — loading a project no
  // longer fills the panel by itself, because those rows are the state of the
  // data when the project was saved, not necessarily the current one.
  const handleUseStoredRows = useCallback((tableId) => {
    const restored = tablesFromNodes(rfInstance.getNodes()).filter(t => t.tableId === tableId)
    if (restored.length === 0) {
      toast.error('No rows for this table are stored in the project')
      return
    }
    window.dispatchEvent(new CustomEvent('tables:import', { detail: restored }))
    toast.success(`${restored[0].allRows.length} stored rows loaded into "${restored[0].name}"`)
  }, [rfInstance, toast])

  // Two placeholders that turn out to be the same file: a table replaced by a
  // newer version under a different name keeps its old id on every node that
  // was mapped before the swap, so one project can refer to more tables than
  // the user ever loaded. Pointing those nodes at a table that is already
  // loaded merges the two without touching a single column mapping.
  const handleAssignTable = useCallback((fromTableId, target) => {
    if (!target?.tableId || target.tableId === fromTableId) return
    let moved = 0
    const missingColumns = new Set()
    setNodes(ns => ns.map(n => {
      if (n.data?.tableId !== fromTableId) return n
      moved++
      if (Array.isArray(target.headers)) {
        if (n.data.mappedColumn && !target.headers.includes(n.data.mappedColumn)) missingColumns.add(n.data.mappedColumn)
        for (const c of Object.values(langValues(n.data, 'labelColumn', languages))) {
          if (!target.headers.includes(c)) missingColumns.add(c)
        }
      }
      return {
        ...n,
        data: { ...n.data, tableId: target.tableId, tableName: target.name, tableRows: target.allRows },
      }
    }))
    toast.success(`${moved} node${moved === 1 ? '' : 's'} now read from "${target.name}"`)
    if (missingColumns.size > 0) {
      toast.error(`Column(s) missing in "${target.name}": "${[...missingColumns].join('", "')}" — check node mapping`)
    }
  }, [setNodes, toast, languages])

  // The single gate every file written from the canvas passes through: the
  // rows currently in the table panel win over the snapshot a node still
  // carries, so a table that was edited outside and loaded again is what ends
  // up in the project file, the Graph Explorer JSON and the RDF. A table that
  // is not loaded right now falls back to its snapshot and is reported.
  const currentGraph = useCallback(() => {
    const { nodes: freshNodes, missing, refreshed } = withLiveRows(rfInstance.getNodes(), liveTables)
    if (missing.length > 0) {
      const names = missing
        .map(m => `"${m.name}" (${m.nodeCount} node${m.nodeCount === 1 ? '' : 's'})`)
        .join(', ')
      toast.info(`Not loaded in the table panel: ${names} — written from the rows stored in the project`)
    }
    return { nodes: freshNodes, edges: rfInstance.getEdges(), missing, refreshed }
  }, [rfInstance, liveTables, toast])

  // Same substitution for the panels that read the rows on screen instead of
  // writing a file.
  const liveNodes = useMemo(() => withLiveRows(nodes, liveTables).nodes, [nodes, liveTables])

  // One label column PER LANGUAGE: dropping SE_Bez while the row shows "de"
  // and SE_Bez_en while it shows "en" is how a table-bound node becomes
  // multilingual. The table bookkeeping (id/name/rows) is shared — every
  // language column comes from the same table as the node's own mapping.
  const handleLabelColumnDrop = useCallback((id, col, lang) => {
    setNodes(ns => ns.map(n => n.id === id ? {
      ...n, data: {
        ...n.data,
        ...patchLangValue(n.data, 'labelColumn', lang, col ? col.name : null, languagesRef.current),
        tableId:     (col && !n.data.tableId)   ? col.tableId : n.data.tableId,
        tableName:   (col && !n.data.tableName) ? (col.tableName || null) : n.data.tableName,
        tableRows:   (col && !n.data.tableRows) ? col.allRows : n.data.tableRows,
      }
    } : n))
    if (col) {
      const langs = languagesRef.current
      const suffix = isMultilingual(langs) ? ` as "${lang || langs.primary}"` : ''
      toast.success(`Label column "${col.name}" assigned${suffix}`)
    }
  }, [setNodes, toast])

  const handleFocusNode = useCallback((id, data) => {
    window.dispatchEvent(new CustomEvent('ontology:focusNode', { detail: data }))
    toast.info(`Subject loaded: ${data.label}`)
  }, [toast])

  const handleToggleNoPrefix = useCallback((id, noPrefix) => {
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, noPrefix } } : n))
  }, [setNodes])

  // Collapsing is purely a display state: it lives in node.data so it survives
  // save/load, and no exporter looks at it.
  const handleToggleCollapse = useCallback((id) => {
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, collapsed: !n.data.collapsed } } : n))
  }, [setNodes])

  const handleCollapseAll = useCallback((collapsed) => {
    setNodes(ns => ns.map(n => n.type === 'ontologyNode'
      ? { ...n, data: { ...n.data, collapsed } } : n))
  }, [setNodes])

  // Fold away the nodes that hang off this one (see utils/collapse.js for the
  // ownership rule). Only the flag is set here — which nodes that actually
  // hides is derived below, so the result stays correct when edges change
  // afterwards.
  const handleToggleChildren = useCallback((id) => {
    setNodes(ns => ns.map(n => n.id === id
      ? { ...n, data: { ...n.data, childrenCollapsed: !n.data.childrenCollapsed } } : n))
  }, [setNodes])

  // Re-derive the hidden set whenever the TOPOLOGY or a collapse flag changes.
  // Keyed on a structural signature rather than on `nodes`/`edges` themselves:
  // moving a node must not trigger it, and the flags this effect writes
  // (hidden / counts) are not part of the key, so it cannot re-trigger itself.
  const collapseKey = useMemo(() => (
    nodes.map(n => (n.data?.childrenCollapsed ? `!${n.id}` : n.id)).join(',') +
    '#' + edges.map(e => `${e.source}>${e.target}`).join(',')
  ), [nodes, edges])

  useEffect(() => {
    const { hidden, hiddenEdges, countByRoot, collapsible } = computeCollapse(nodes, edges)
    let nodesDirty = false
    const nextNodes = nodes.map(n => {
      const isHidden   = hidden.has(n.id)
      const count      = countByRoot[n.id] || 0
      const canCollapse = collapsible.has(n.id)
      if (!!n.hidden === isHidden &&
          (n.data?.hiddenChildCount || 0) === count &&
          !!n.data?.hasCollapsibleChildren === canCollapse) return n
      nodesDirty = true
      return { ...n, hidden: isHidden, data: { ...n.data, hiddenChildCount: count, hasCollapsibleChildren: canCollapse } }
    })
    if (nodesDirty) setNodes(nextNodes)

    let edgesDirty = false
    const nextEdges = edges.map(e => {
      const isHidden = hiddenEdges.has(e.id)
      if (!!e.hidden === isHidden) return e
      edgesDirty = true
      return { ...e, hidden: isHidden }
    })
    if (edgesDirty) setEdges(nextEdges)
  }, [collapseKey])   // eslint-disable-line react-hooks/exhaustive-deps

  const handleExplorerLabelChange = useCallback((id, explorerLabel, lang) => {
    const value = (explorerLabel || '').trim()
    setNodes(ns => ns.map(n => n.id === id
      ? { ...n, data: { ...n.data, ...patchLangValue(n.data, 'explorerLabel', lang, value, languagesRef.current) } }
      : n))
  }, [setNodes])

  // ── Re-class a node ─────────────────────────────────────────────────────────
  // Opens the picker. The change itself (see handleClassChangeConfirm) swaps
  // ONLY the ontology class of the node — its id, position, edges, column
  // mappings, instance/Explorer labels, literal flag and named-graph membership
  // are left as they are, so the project file, the GraphML / Graph Explorer JSON
  // and the RDF export all simply carry the new class where they carried the old.
  const handleChangeClassRequest = useCallback((id) => {
    const node = rfInstance.getNodes().find(n => n.id === id)
    if (!node) return
    const allEdges = rfInstance.getEdges()
    // A dot-one split stores the real target on seg1 (edge.target is the
    // midpoint helper), so count via originalTarget and skip seg2 to avoid
    // counting the same connection twice.
    const touches = (e) => e.source === id || e.target === id || e.data?.originalTarget === id
    setChangingClass({
      node,
      connectionCount: allEdges.filter(e => touches(e) && !e.data?.isSplitSeg2).length,
      outgoingEdges:   allEdges.filter(e => e.source === id && !e.data?.isDotOne && !e.data?.isSplitSeg2),
    })
  }, [rfInstance])

  const resolveNodeColor = useCallback(async (uri) => {
    try {
      const d = await api.getSuperclasses(uri)
      return resolveColor(uri, (d.superclasses || []).map(s => s.uri))
    } catch {
      return resolveColor(uri, [])
    }
  }, [])

  // Every node carries the same callback bundle. Kept in one place so a node
  // created on a new path (import, free node, project load) cannot silently
  // miss one and end up with a dead button.
  const nodeCallbacks = useMemo(() => ({
    onDelete:              handleDeleteNode,
    onLabelChange:         handleLabelChange,
    onColumnDrop:          handleColumnDrop,
    onLabelColumnDrop:     handleLabelColumnDrop,
    onToggleNoPrefix:      handleToggleNoPrefix,
    onExplorerLabelChange: handleExplorerLabelChange,
    onFocus:               handleFocusNode,
    onChangeClass:         handleChangeClassRequest,
    onToggleCollapse:      handleToggleCollapse,
    onToggleChildren:      handleToggleChildren,
  }), [handleDeleteNode, handleLabelChange, handleColumnDrop, handleLabelColumnDrop, handleToggleNoPrefix, handleExplorerLabelChange, handleFocusNode, handleChangeClassRequest, handleToggleCollapse, handleToggleChildren])

  const makeNodeData = useCallback((item, nodeType, color) => ({
    label:         item.label,
    uri:           item.uri,
    nodeType,
    rdfs_label:    item.rdfs_label,
    nodeColor:     color || '#e8e8e8',
    mappedColumn:  null,
    labelColumn:   null,
    instanceLabel: '',
    noPrefix:      false,
    explorerLabel: '',
    ...nodeCallbacks,
  }), [nodeCallbacks])

  const addNodeWithColor = useCallback(async (item, nodeType, pos) => {
    const id = `n${nodeCounter++}`
    setNodes(ns => [...ns, { id, type: 'ontologyNode', position: pos, data: makeNodeData(item, nodeType, '#e8e8e8') }])
    const { color } = await resolveNodeColor(item.uri)
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, nodeColor: color } } : n))
    return id
  }, [setNodes, makeNodeData, resolveNodeColor])

  // Apply a re-class: replace the class fields (and the colour that derives
  // from them) in place. Every other data field is spread through untouched.
  const handleClassChangeConfirm = useCallback(async (newClass) => {
    if (!changingClass) return
    const id       = changingClass.node.id
    const oldLabel = changingClass.node.data?.label || '—'

    setNodes(ns => ns.map(n => n.id === id ? {
      ...n,
      data: {
        ...n.data,
        label:      newClass.label,
        uri:        newClass.uri,
        rdfs_label: newClass.rdfs_label || '',
        isFreeNode: !!newClass.isFreeNode,
      },
    } : n))
    setChangingClass(null)
    toast.success(`Class changed: ${oldLabel} → ${newClass.label}`)

    // Colour follows the new class (CIDOC convention, resolved via its
    // superclasses); custom xsd:/geo: classes use the namespace heuristic.
    const color = freeClassColor(newClass.label, newClass.uri)
      || (await resolveNodeColor(newClass.uri)).color
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, nodeColor: color } } : n))
  }, [changingClass, setNodes, resolveNodeColor, toast])

  const findNodeAtScreenPos = useCallback((clientX, clientY) => {
    if (!rfWrapper.current) return null
    const bounds  = rfWrapper.current.getBoundingClientRect()
    const flowPos = rfInstance.screenToFlowPosition({ x: clientX - bounds.left, y: clientY - bounds.top })
    for (const n of rfInstance.getNodes()) {
      const w = n.width  ?? 230
      const h = n.height ?? 100
      const pad = 20
      if (
        flowPos.x >= n.position.x - pad && flowPos.x <= n.position.x + w + pad &&
        flowPos.y >= n.position.y - pad && flowPos.y <= n.position.y + h + pad
      ) return n
    }
    return null
  }, [rfInstance])

  // Pick the nearest source/target handle pair based on relative position
  const pickNearestHandles = useCallback((sourceNode, targetPos) => {
    const sw = sourceNode.width  ?? 200
    const sh = sourceNode.height ?? 100
    const srcCx = sourceNode.position.x + sw / 2
    const srcCy = sourceNode.position.y + sh / 2
    const dx = targetPos.x - srcCx
    const dy = targetPos.y - srcCy

    let srcSide, tgtSide
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) { srcSide = 'r'; tgtSide = 'l' }
      else        { srcSide = 'l'; tgtSide = 'r' }
    } else {
      if (dy > 0) { srcSide = 'b'; tgtSide = 't' }
      else        { srcSide = 't'; tgtSide = 'b' }
    }
    return { srcHandle: `${srcSide}-s`, tgtHandle: `${tgtSide}-t` }
  }, [])

  // Find the nearest edge to a flow-space position (for dot-one drop)
  const findEdgeAtPos = useCallback((flowPos) => {
    const allNodes = rfInstance.getNodes()
    const allEdges = rfInstance.getEdges()
    const threshold = 50  // px proximity – generous for usability

    // Check if pos hits a node – if yes, don't match edges (node takes priority)
    for (const n of allNodes) {
      const w = n.width ?? 200, h = n.height ?? 100
      if (flowPos.x >= n.position.x && flowPos.x <= n.position.x + w &&
          flowPos.y >= n.position.y && flowPos.y <= n.position.y + h) {
        return null  // hit a node, not an edge
      }
    }

    let bestEdge = null, bestDist = threshold
    for (const edge of allEdges) {
      const src = allNodes.find(n => n.id === edge.source)
      const tgt = allNodes.find(n => n.id === edge.target)
      if (!src || !tgt) continue

      // Approximate edge as line between node centers
      const sx = src.position.x + (src.width ?? 200) / 2
      const sy = src.position.y + (src.height ?? 100) / 2
      const tx = tgt.position.x + (tgt.width ?? 200) / 2
      const ty = tgt.position.y + (tgt.height ?? 100) / 2

      const dx = tx - sx, dy = ty - sy
      const lenSq = dx * dx + dy * dy
      if (lenSq === 0) continue
      const t = Math.max(0, Math.min(1, ((flowPos.x - sx) * dx + (flowPos.y - sy) * dy) / lenSq))
      const px = sx + t * dx, py = sy + t * dy
      const dist = Math.sqrt((flowPos.x - px) ** 2 + (flowPos.y - py) ** 2)

      if (dist < bestDist) { bestDist = dist; bestEdge = edge }
    }
    return bestEdge
  }, [rfInstance])

  // Dot-One confirm: SPLIT original edge through midpoint, create dot-one class node + edge
  // Graph: Source ──seg1──▶ Midpoint ──seg2──▶ Target
  //                              └──dot1──▶ DotOneClassNode
  // Export: seg1 carries the original property + dot-one metadata, seg2 + dot1 are skipped
  const handleDotOneConfirm = useCallback(async (dotOneProp, dotOneTargetUri, dotOnePropUri) => {
    if (!pendingDotOne) return
    const { edge: origEdge, sourceNode, targetNode, dotItem } = pendingDotOne
    const origId = origEdge.id
    const origLabel = origEdge.data?.label || origEdge.label || ''
    const origData = origEdge.data || {}

    // 1. Calculate midpoint position between source and target
    const sx = sourceNode.position.x + (sourceNode.width ?? 200) / 2
    const sy = sourceNode.position.y + (sourceNode.height ?? 100) / 2
    const tx = targetNode.position.x + (targetNode.width ?? 200) / 2
    const ty = targetNode.position.y + (targetNode.height ?? 100) / 2
    const midX = (sx + tx) / 2 - 7
    const midY = (sy + ty) / 2 - 7

    // 2. Determine handle directions based on dominant axis
    const dx = tx - sx, dy = ty - sy
    let srcOut, midIn, midOut, tgtIn
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) { srcOut = 'r'; midIn = 'l'; midOut = 'r'; tgtIn = 'l' }
      else        { srcOut = 'l'; midIn = 'r'; midOut = 'l'; tgtIn = 'r' }
    } else {
      if (dy > 0) { srcOut = 'b'; midIn = 't'; midOut = 'b'; tgtIn = 't' }
      else        { srcOut = 't'; midIn = 'b'; midOut = 't'; tgtIn = 'b' }
    }

    // 3. Create midpoint node
    const midId = `mid_${Date.now()}`
    const midNode = {
      id: midId, type: 'dotOneMidpoint',
      position: { x: midX, y: midY },
      data: { parentEdgeLabel: origLabel },
      draggable: true, width: 14, height: 14,
    }

    // 4. Create two split edges: Source→Midpoint (seg1) and Midpoint→Target (seg2)
    const dotNodeId = `n${nodeCounter++}`
    const seg1 = {
      id: `${origId}_seg1`,
      source: origEdge.source,
      target: midId,
      sourceHandle: origEdge.sourceHandle || `${srcOut}-s`,
      targetHandle: `mid-t-${midIn}`,
      label: origLabel,
      data: {
        ...origData,
        // Export metadata: seg1 is the "main" edge that carries property + dot-one info
        isSplitSeg1: true,
        originalTarget: origEdge.target,  // real target (for export to resolve)
        dotOneProp: dotOneProp,
        dotOnePropUri: dotOnePropUri || '',  // full URI for RDF export
        dotOneNodeId: dotNodeId,
        dotOneEdgeId: `${origId}_dot1`,
      },
      style: EDGE_STYLE, markerEnd: EDGE_MARKER, ...EDGE_LABEL_STYLE,
    }
    const seg2 = {
      id: `${origId}_seg2`,
      source: midId,
      target: origEdge.target,
      sourceHandle: `mid-s-${midOut}`,
      targetHandle: origEdge.targetHandle || `${tgtIn}-t`,
      label: '',
      data: { isSplitSeg2: true },
      style: EDGE_STYLE, markerEnd: EDGE_MARKER,
    }

    // 5. Create dot-one class node (below midpoint)
    const dotNodePos = { x: midX - 80, y: midY + 80 }
    const dotNodeData = makeNodeData(
      { label: dotItem.label, uri: dotItem.uri, rdfs_label: dotItem.rdfs_label },
      'object', '#e8e8e8'
    )

    // 6. Create dot-one edge (midpoint → class node)
    const dotEdge = makeDotOneEdge(`${origId}_dot1`, midId, dotNodeId, dotOneProp)

    // 7. Apply: remove original edge, add midpoint + segments + dot-one
    setEdges(es => [
      ...es.filter(e => e.id !== origId),
      seg1, seg2, dotEdge,
    ])
    setNodes(ns => [...ns, midNode, {
      id: dotNodeId, type: 'ontologyNode', position: dotNodePos, data: dotNodeData,
    }])

    // 8. Resolve color async
    try {
      const { color } = await resolveNodeColor(dotItem.uri)
      setNodes(ns => ns.map(n => n.id === dotNodeId ? { ...n, data: { ...n.data, nodeColor: color } } : n))
    } catch {}

    toast.success(`Dot-One: ${origLabel} .${dotOneProp.split(/[#/:]/).pop()} → ${dotItem.label}`)
    setPendingDotOne(null)
  }, [pendingDotOne, setEdges, setNodes, makeNodeData, resolveNodeColor, toast])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    const raw    = e.dataTransfer.getData('application/ontology')
    const colRaw = e.dataTransfer.getData('application/column')

    if (colRaw) {
      const col = JSON.parse(colRaw)
      const hit = findNodeAtScreenPos(e.clientX, e.clientY)
      if (hit) {
        const bounds  = rfWrapper.current.getBoundingClientRect()
        const flowPos = rfInstance.screenToFlowPosition({ x: e.clientX - bounds.left, y: e.clientY - bounds.top })
        const midY    = hit.position.y + (hit.height ?? 100) / 2
        if (flowPos.y < midY) handleLabelColumnDrop(hit.id, col)
        else                  handleColumnDrop(hit.id, col)
      } else {
        toast.error('Missed the node — try dropping closer to it')
      }
      return
    }

    if (!raw) return
    const item   = JSON.parse(raw)
    const bounds = rfWrapper.current.getBoundingClientRect()
    const pos    = rfInstance.screenToFlowPosition({ x: e.clientX - bounds.left, y: e.clientY - bounds.top })

    // ── Check if dropped on an existing edge → Dot-One attachment ────────────
    // Strategy 1: proximity-based hit test (zoom-aware)
    const hitEdge = findEdgeAtPos(pos)
    // Strategy 2: if an edge is currently selected and no node was hit, use that
    const selectedEdge = !hitEdge ? rfInstance.getEdges().find(e => e.selected) : null
    const dotOneEdge = hitEdge || selectedEdge

    if (dotOneEdge && (item.type === 'subject' || item.type === 'object')) {
      const allNodes = rfInstance.getNodes()
      // Make sure we didn't land on a node (node-drop takes priority)
      const hitNode = allNodes.find(n => {
        const w = n.width ?? 200, h = n.height ?? 100
        return pos.x >= n.position.x && pos.x <= n.position.x + w &&
               pos.y >= n.position.y && pos.y <= n.position.y + h
      })
      if (!hitNode) {
        const sourceNode = allNodes.find(n => n.id === dotOneEdge.source)
        const targetNode = allNodes.find(n => n.id === dotOneEdge.target)
        setPendingDotOne({
          edge: dotOneEdge,
          sourceNode,
          targetNode,
          dotItem: item,
        })
        return
      }
    }

    if (item.type === 'subject') {
      const existing = rfInstance.getNodes().find(n => n.data.uri === item.uri)
      if (existing) toast.info(`Note: ${item.label} is already in the graph`)
      addNodeWithColor(item, 'subject', pos)
    } else if (item.type === 'object') {
      const source = rfInstance.getNodes().find(n => n.selected)
      addNodeWithColor(item, 'object', pos).then(id => {
        if (source && item.predicate) {
          const { srcHandle, tgtHandle } = pickNearestHandles(source, pos)
          setEdges(es => [...es, makeEdge(`e_${source.id}_${id}`, source.id, id, item.predicate, srcHandle, tgtHandle)])
          toast.success(`${source.data.label} → ${item.predicate.label} → ${item.label}`)
        } else if (!source) {
          toast.info('Tip: select a node first, then drop an object for auto-linking')
        }
      })
    }
  }, [rfInstance, findNodeAtScreenPos, findEdgeAtPos, addNodeWithColor, setEdges, handleColumnDrop, handleLabelColumnDrop, pickNearestHandles, toast])

  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }

  const onConnect = useCallback((params) => {
    const allNodes   = rfInstance.getNodes()
    const sourceNode = allNodes.find(n => n.id === params.source)
    const targetNode = allNodes.find(n => n.id === params.target)
    setPendingConnect({ params, sourceNode, targetNode })
  }, [rfInstance])

  const handlePropertyChosen = useCallback((prop) => {
    if (!pendingConnect) return
    const { params } = pendingConnect
    const id = `e_${params.source}_${params.target}_${Date.now()}`
    setEdges(es => addEdge(
      makeEdge(id, params.source, params.target, prop, params.sourceHandle, params.targetHandle),
      es
    ))
    toast.success(`Property "${prop.label}" added`)
    setPendingConnect(null)
  }, [pendingConnect, setEdges, toast])

  // ── Edge double-click → open edit modal ─────────────────────────────────────
  const onEdgeDoubleClick = useCallback((event, edge) => {
    event.stopPropagation()
    const allNodes = rfInstance.getNodes()
    const sourceNode = allNodes.find(n => n.id === edge.source)
    const targetNode = allNodes.find(n => n.id === edge.target)
    setEditingEdge({ edge, sourceNode, targetNode })
  }, [rfInstance])

  const handleEdgeUpdate = useCallback((updatedData) => {
    if (!editingEdge) return
    const eid = editingEdge.edge.id
    setEdges(es => es.map(e => {
      if (e.id !== eid) return e
      return {
        ...e,
        // The property label is the one field that keeps a fallback: an edge
        // without a name would render as a blank connection.
        label: updatedData.label || e.label,
        sourceHandle: pickField(updatedData.sourceHandle, e.sourceHandle),
        targetHandle: pickField(updatedData.targetHandle, e.targetHandle),
        data: {
          ...e.data,
          label: updatedData.label || e.data?.label,
          propertyUri:        pickField(updatedData.propertyUri,        e.data?.propertyUri),
          joinColumnSource:   pickField(updatedData.joinColumnSource,   e.data?.joinColumnSource ?? null),
          joinColumnTarget:   pickField(updatedData.joinColumnTarget,   e.data?.joinColumnTarget ?? null),
          dotOne:             pickField(updatedData.dotOne,             e.data?.dotOne ?? null),
          dotOneTarget:       pickField(updatedData.dotOneTarget,       e.data?.dotOneTarget ?? null),
          noInverse:          pickField(updatedData.noInverse,          e.data?.noInverse ?? false),
          inversePropertyUri: (pickField(updatedData.inversePropertyUri, e.data?.inversePropertyUri) || '').trim(),
          explorerLabel:      (pickField(updatedData.explorerLabel,     e.data?.explorerLabel)      || '').trim(),
        },
      }
    }))
    toast.success('Edge updated')
    setEditingEdge(null)
  }, [editingEdge, setEdges, toast])

  // The two TSVs the RDF and Graph Explorer exports are built from. Was step 1
  // of the RDF pipeline; kept as a plain download for anyone feeding the fully
  // resolved URIs into their own tooling.
  const handleExportTSV = () => {
    const nsMap = {}
    Object.entries(prefixMap).forEach(([pfx, ns]) => { nsMap[pfx] = ns })
    const { nodes: exportNodes, edges: exportEdges } = currentGraph()
    const result = exportRdfPipelineTSV(exportNodes, exportEdges, tableData, nsMap, idPrefix, namedGraphs, languages)
    if (result.uriRowCount === 0 && result.literalRowCount === 0) {
      toast.error('No data to export — please load a table and assign columns')
      return
    }
    downloadText('Triples_URI.tsv', result.uriTSV, 'text/tab-separated-values')
    downloadText('Triples_URI_literal.tsv', result.literalTSV, 'text/tab-separated-values')
    toast.success(`TSV exported: ${result.uriRowCount} URI rows, ${result.literalRowCount} literal rows`)
  }

  const handleExportGraphML = () => {
    downloadText('ontology-graph.graphml', exportGraphML(rfInstance.getNodes(), rfInstance.getEdges()))
    toast.success('GraphML exported')
  }

  const handleExportImage = async (format) => {
    const viewport = document.querySelector('.react-flow__viewport')
    if (!viewport) { toast.error('No graph to export'); return }
    try {
      const { toPng, toSvg } = await import('html-to-image')
      const allNodes = rfInstance.getNodes()
      if (allNodes.length === 0) { toast.error('Graph is empty'); return }

      const nodesBounds = allNodes.reduce((acc, n) => {
        const x = n.position.x
        const y = n.position.y
        return {
          minX: Math.min(acc.minX, x),
          minY: Math.min(acc.minY, y),
          maxX: Math.max(acc.maxX, x + 240),
          maxY: Math.max(acc.maxY, y + 120),
        }
      }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

      const padding = 60
      rfInstance.fitBounds({
        x: nodesBounds.minX - padding,
        y: nodesBounds.minY - padding,
        width: nodesBounds.maxX - nodesBounds.minX + padding * 2,
        height: nodesBounds.maxY - nodesBounds.minY + padding * 2,
      }, { duration: 0 })

      await new Promise(r => setTimeout(r, 150))

      const rfEl = rfWrapper.current?.querySelector('.react-flow')
      if (!rfEl) { toast.error('ReactFlow element not found'); return }

      const imageOpts = {
        backgroundColor: '#f4f8f9',
        quality: 1.0,
        pixelRatio: 2,
        skipFonts: true,
        fontEmbedCSS: '',
        filter: (node) => {
          if (node?.classList?.contains('react-flow__minimap')) return false
          if (node?.classList?.contains('react-flow__controls')) return false
          if (node?.classList?.contains('react-flow__attribution')) return false
          return true
        },
        style: {
          fontFamily: "'IBM Plex Sans', 'Segoe UI', Arial, sans-serif",
        },
      }

      if (format === 'svg') {
        const svgData = await toSvg(rfEl, imageOpts)
        const link = document.createElement('a')
        link.download = 'ontology-graph.svg'
        link.href = svgData
        link.click()
        toast.success('SVG exported')
      } else {
        const pngData = await toPng(rfEl, imageOpts)
        const link = document.createElement('a')
        link.download = 'ontology-graph.png'
        link.href = pngData
        link.click()
        toast.success('PNG exported')
      }
    } catch (err) {
      console.error('Image export error:', err)
      toast.error(`Export failed: ${err.message}`)
    }
  }

  const [showExportMenu, setShowExportMenu] = useState(false)
  const exportMenuRef = useRef(null)

  useEffect(() => {
    if (!showExportMenu) return
    const handleClickOutside = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setShowExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showExportMenu])

  useEffect(() => {
    if (!showLangMenu) return
    const handleClickOutside = (e) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target)) setShowLangMenu(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showLangMenu])

  const [rdfExportFormat, setRdfExportFormat] = useState('trig')

  const handleExportRdf = async (fmt) => {
    const format = fmt || rdfExportFormat
    const nsMap = {}
    Object.entries(prefixMap).forEach(([pfx, ns]) => { nsMap[pfx] = ns })
    // Rows come from the table panel as it stands right now, so re-loading an
    // edited table and exporting again is all it takes to update the RDF.
    const { nodes: exportNodes, edges: exportEdges } = currentGraph()
    const result = exportRdfPipelineTSV(exportNodes, exportEdges, tableData, nsMap, idPrefix, namedGraphs, languages)
    if (result.uriRowCount === 0 && result.literalRowCount === 0) {
      toast.error('No data to export — please load a table and assign columns')
      return
    }
    toast.info(`Generating RDF (${result.uriRowCount} URI + ${result.literalRowCount} literal rows)…`)
    try {
      const res = await api.exportRdf(result.uriTSV, result.literalTSV, format, languages)
      if (res.triple_count === 0) {
        // Show debug info to help diagnose
        const dbg = res.debug || {}
        const skipped = (res.skipped_uris || []).slice(0, 5).join(', ')
        toast.error(`No triples written — the backend parsed ${dbg.uri_rows_parsed || 0} URI rows. Skipped: ${skipped || 'none'}. Are all prefixes defined in the Prefix Manager?`)
        console.warn('RDF Export Debug:', res.debug, 'Skipped:', res.skipped_uris)
        return
      }
      downloadText(`ontology-export${res.extension}`, res.rdf, res.mime_type)
      const skippedMsg = res.skipped_uris?.length ? ` (${res.skipped_uris.length} URIs skipped)` : ''
      toast.success(`${res.format} exported: ${res.triple_count} triples${skippedMsg}`)
      if (res.skipped_uris?.length) {
        console.warn('Skipped URIs (unresolved):', res.skipped_uris)
      }
    } catch (e) {
      toast.error('RDF export error: ' + e.message)
    }
  }

  // ── Graph Explorer: collect schema info from current canvas ─────────────
  const collectSchemaHints = useCallback(() => {
    const currentNodes = rfInstance.getNodes()
    const currentEdges = rfInstance.getEdges()
    const typeColors = {}
    const typeLabels = {}
    currentNodes.forEach(n => {
      if (n.type === 'dotOneMidpoint') return
      const uri = n.data?.uri
      const color = n.data?.nodeColor
      const label = n.data?.rdfs_label || n.data?.label
      if (uri) {
        if (color) typeColors[uri] = color
        if (label) typeLabels[uri] = label
      }
    })
    const edgeLabels = {}
    currentEdges.forEach(e => {
      const uri = e.data?.propertyUri
      const label = e.data?.label
      if (uri && label) edgeLabels[uri] = label
    })
    return { typeColors, typeLabels, edgeLabels }
  }, [rfInstance])

  const handleExploreInGraphExplorer = useCallback(async () => {
    const nsMap = {}
    Object.entries(prefixMap).forEach(([pfx, ns]) => { nsMap[pfx] = ns })
    // Same rule as the RDF export: the currently loaded tables are the data.
    const { nodes: exportNodes, edges: exportEdges } = currentGraph()
    const result = exportRdfPipelineTSV(exportNodes, exportEdges, tableData, nsMap, idPrefix, namedGraphs, languages)
    if (result.uriRowCount === 0 && result.literalRowCount === 0) {
      toast.error('No data to explore — please load a table and assign columns')
      return
    }
    toast.info('Preparing Graph Explorer…')
    try {
      const { typeColors, typeLabels, edgeLabels } = collectSchemaHints()
      const projectTitle = rfInstance.getNodes().filter(n => n.type !== 'dotOneMidpoint').length > 0
        ? 'OntoCartographer Graph Export'
        : 'RDF Graph'
      const graphJson = await api.exportGraphExplorerJson(
        result.uriTSV, result.literalTSV,
        projectTitle, typeColors, typeLabels, edgeLabels, languages
      )
      if (!graphJson || !graphJson.nodes || Object.keys(graphJson.nodes).length === 0) {
        toast.error('Graph Explorer: no nodes generated. Are all prefixes defined?')
        return
      }
      // Download the JSON so it can be loaded into the Explorer
      downloadText('graph-explorer-data.json', JSON.stringify(graphJson, null, 2), 'application/json')
      toast.success(`Graph JSON exported: ${graphJson.meta?.node_count} nodes · ${graphJson.meta?.edge_count} edges — now drop it into the GraphExplorer`)
    } catch (e) {
      toast.error('Graph Explorer export error: ' + e.message)
    }
  }, [rfInstance, currentGraph, prefixMap, tableData, idPrefix, namedGraphs, collectSchemaHints, toast, languages])

  // ── Language Manager save handler ───────────────────────────────────────
  //
  // Changing the primary language is not a display change — the flat node
  // fields ARE the primary language, so their contents have to move with it.
  // `remapNodeLanguages` lifts every label into a {lang: value} map and
  // re-splits it against the new primary; without that, switching de→en
  // would leave German text in the field the exporter tags @en, which is
  // exactly the bug this feature exists to remove.
  const handleLanguagesSave = useCallback((next) => {
    const to = normalizeLanguages(next)
    setNodes(ns => ns.map(n => n.type === 'dotOneMidpoint'
      ? n
      : { ...n, data: remapNodeLanguages(n.data, languages, to) }))
    setLanguages(to)
    setActiveLang(to.primary)
    setShowLanguageManager(false)
    const extra = to.additional.length > 0 ? ` + ${to.additional.join(', ')}` : ''
    toast.success(`Languages: ${to.primary} (primary)${extra}`)
  }, [languages, setNodes, setLanguages, setActiveLang, toast])

  // ── Prefix Manager save handler ─────────────────────────────────────────
  const handlePrefixSave = useCallback((newMap, newIdPrefix) => {
    setPrefixMap(newMap)
    setIdPrefix(newIdPrefix)
    toast.success('Prefixes saved')
  }, [setPrefixMap, setIdPrefix, toast])

  // ── Free Node (custom class, e.g. xsd:date) ────────────────────────────
  const handleAddFreeNode = useCallback(() => {
    const label = freeNodeLabel.trim()
    const uri   = freeNodeUri.trim()
    if (!label) { toast.error('Please enter a class label'); return }

    const id = `n${nodeCounter++}`
    // Determine a color – try to resolve from ontology, or use white
    const nodeData = {
      label:         label,
      uri:           uri || label,
      nodeType:      'subject',
      rdfs_label:    label,
      nodeColor:     uri && uri.includes('xsd:') ? '#86bcc8' :
                     uri && uri.includes('geo:') ? '#94cc7d' :
                     label.startsWith('xsd:') ? '#86bcc8' :
                     label.startsWith('geo:') ? '#94cc7d' : '#e8e8e8',
      mappedColumn:  null,
      labelColumn:   null,
      instanceLabel: '',
      isFreeNode:    true,
      noPrefix:      label.startsWith('xsd:') || label.startsWith('geo:') ||
                     (uri && (uri.includes('xsd:') || uri.includes('XMLSchema') || uri.includes('geo:'))),
      explorerLabel: '',
      ...nodeCallbacks,
    }

    // Place near viewport center
    const viewport = rfInstance.getViewport()
    const pos = rfInstance.screenToFlowPosition({
      x: (rfWrapper.current?.clientWidth  || 800) / 2,
      y: (rfWrapper.current?.clientHeight || 600) / 2,
    })

    setNodes(ns => [...ns, { id, type: 'ontologyNode', position: pos, data: nodeData }])

    // Try to resolve color from ontology (async, best-effort)
    if (uri && !uri.startsWith('xsd:') && !uri.startsWith('geo:')) {
      resolveNodeColor(uri).then(({ color }) => {
        setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, nodeColor: color } } : n))
      }).catch(() => {})
    }

    toast.success(`Free node "${label}" created`)
    setFreeNodeLabel('')
    setFreeNodeUri('')
    setShowFreeNode(false)
  }, [freeNodeLabel, freeNodeUri, rfInstance, setNodes, nodeCallbacks, resolveNodeColor, toast])

  // ── Import an existing graph (RDF / Graph Explorer JSON) ────────────────────
  // The backend lifts the instance graph onto the schema level (one group per
  // rdf:type); buildImportedGraph turns those groups into ORDINARY mapped
  // nodes. From here on nothing is special about them — re-classing,
  // re-connecting and both exports run through the existing code paths.
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    toast.info(`Reading ${file.name}…`)
    try {
      const payload = await api.importGraph(file)
      if (!payload?.classes?.length) {
        toast.error('No classes found in this file')
        return
      }
      setImportPreview({ payload, fileName: file.name })
    } catch (err) {
      toast.error('Import failed: ' + err.message)
    }
  }

  const handleImportConfirm = useCallback(async () => {
    if (!importPreview) return
    const { payload } = importPreview
    setImportPreview(null)

    const built = buildImportedGraph(payload, () => `n${nodeCounter++}`)

    setNodes(ns => [...ns, ...built.nodes.map(n => ({
      ...n, data: { ...n.data, ...nodeCallbacks },
    }))])
    setEdges(es => [...es, ...built.edges.map(ed => ({
      ...ed, style: EDGE_STYLE, markerEnd: EDGE_MARKER, ...EDGE_LABEL_STYLE,
    }))])

    // Hand the synthetic tables to the table panel so their columns can be
    // dragged onto further nodes, exactly like an uploaded spreadsheet.
    window.dispatchEvent(new CustomEvent('tables:import', { detail: built.tables }))

    toast.success(
      `Imported: ${built.summary.class_count} classes · ${built.summary.relation_count} connections · ` +
      `${built.summary.instance_count} instances`
    )
    for (const w of (built.summary.warnings || [])) toast.info(w)

    // Colour the class nodes by the CIDOC convention (one lookup per class).
    const classUris = [...new Set(built.nodes.map(n => n.data?.uri).filter(u => u && String(u).startsWith('http')))]
    const colors = {}
    await Promise.all(classUris.map(async uri => {
      try { colors[uri] = (await resolveNodeColor(uri)).color } catch { /* keep placeholder */ }
    }))
    // Literal nodes keep their namespace-based colour — the CIDOC lookup has
    // nothing to say about xsd:*/geo:* and would flatten them to white.
    setNodes(ns => ns.map(n => (n.data?.importedFrom && !n.data?.isFreeNode && colors[n.data?.uri])
      ? { ...n, data: { ...n.data, nodeColor: colors[n.data.uri] } }
      : n))

    setTimeout(() => rfInstance.fitView({ duration: 400, padding: 0.15, minZoom: 0.02, maxZoom: 1.5 }), 80)
  }, [importPreview, setNodes, setEdges, nodeCallbacks, resolveNodeColor, rfInstance, toast])

  // v5 writes the rows of the currently loaded tables (not the ones the nodes
  // were mapped with) and adds a `tables` section, which is what the next
  // session builds its table placeholders from.
  // v6 adds `languages`. The node fields themselves are unchanged for a
  // single-language project — only additional languages add the *I18n maps —
  // so a v6 file with one language is a v5 file plus one line.
  const handleSaveProject = () => {
    const { nodes: exportNodes, edges: exportEdges, refreshed } = currentGraph()
    const project = {
      version: 6,
      idPrefix, prefixMap, wideningParent, wideningChild: widening, namedGraphs,
      languages,
      tables: tableMetaForProject(exportNodes, liveTables),
      nodes: exportNodes,
      edges: exportEdges,
    }
    downloadText('ontocartographer-project.json', JSON.stringify(project, null, 2), 'application/json')
    const note = refreshed.length > 0
      ? ` · ${refreshed.length} table${refreshed.length === 1 ? '' : 's'} written with the currently loaded rows`
      : ''
    toast.success(`Project saved${note}`)
  }

  // ── Graph Verification ──────────────────────────────────────────────────────
  const handleVerify = useCallback(async () => {
    // Checks the data as it would be written, not the snapshot the nodes were
    // mapped with — a row count or a sample value from a stale table would
    // report on something no export produces any more.
    const allNodes = liveNodes
    const allEdges = rfInstance.getEdges()
    const issues = []

    if (allNodes.length === 0) {
      toast.info('Nothing to verify — graph is empty')
      return
    }

    // 1. Nodes without any mapped column AND without instanceLabel
    //    (skip dot-one midpoint nodes – they are internal helpers without data)
    for (const n of allNodes) {
      if (n.type === 'dotOneMidpoint') continue
      const d = n.data || {}
      if (!d.mappedColumn && !d.instanceLabel) {
        issues.push({ type: 'warn', node: n.id, msg: `Node "${d.label}" (${n.id}): Neither ID column nor label assigned` })
      }
    }

    // 2. Nodes with mappedColumn but no labelColumn (and vice versa check)
    for (const n of allNodes) {
      if (n.type === 'dotOneMidpoint') continue
      const d = n.data || {}
      if (d.mappedColumn && !d.labelColumn && !d.instanceLabel) {
        issues.push({ type: 'info', node: n.id, msg: `Node "${d.label}" (${n.id}): ID column set but no label — Domain_label/Range_Label will be empty` })
      }
    }

    // 2b. Missing translations. This is where the bulk "who still needs an
    //     English label?" question is answered — deliberately here and not on
    //     the canvas, which is what lets the per-node chips stay at 26px.
    //     Reported once per language with a node count, not once per node:
    //     a fresh second language would otherwise bury every other finding.
    if (isMultilingual(languages)) {
      for (const lang of languages.additional) {
        const missingLabel = []
        const missingExplorer = []
        for (const n of allNodes) {
          if (n.type === 'dotOneMidpoint') continue
          const d = n.data || {}
          // Only nodes that HAVE the field in the primary language can be
          // missing a translation of it — a node with no label at all is
          // already covered by check 1.
          if (hasLabelIn(d, languages.primary, languages) && !hasLabelIn(d, lang, languages)) {
            missingLabel.push(d.label || n.id)
          }
          if (hasExplorerLabelIn(d, languages.primary, languages) && !hasExplorerLabelIn(d, lang, languages)) {
            missingExplorer.push(d.label || n.id)
          }
        }
        if (missingLabel.length > 0) {
          issues.push({ type: 'info', node: null, msg: `Language "${lang}": ${missingLabel.length} node(s) without a label — ${missingLabel.slice(0, 6).join(', ')}${missingLabel.length > 6 ? ', …' : ''}` })
        }
        if (missingExplorer.length > 0) {
          issues.push({ type: 'info', node: null, msg: `Language "${lang}": ${missingExplorer.length} node(s) without an Explorer name — ${missingExplorer.slice(0, 6).join(', ')}${missingExplorer.length > 6 ? ', …' : ''}` })
        }
      }
    }

    // 3. Possible ID/Label swap: if mappedColumn values look like labels (contain spaces)
    for (const n of allNodes) {
      if (n.type === 'dotOneMidpoint') continue
      const d = n.data || {}
      if (d.mappedColumn && d.tableRows?.length > 0) {
        const firstVal = String(d.tableRows[0][d.mappedColumn] ?? '')
        if (firstVal && /\s/.test(firstVal) && !/^"/.test(firstVal)) {
          issues.push({ type: 'warn', node: n.id, msg: `Node "${d.label}" (${n.id}): ID column "${d.mappedColumn}" contains spaces ("${firstVal.slice(0,30)}…") – possibly ID and label swapped?` })
        }
      }
      if (d.labelColumn && d.tableRows?.length > 0) {
        const firstVal = String(d.tableRows[0][d.labelColumn] ?? '')
        if (firstVal && /^[a-z]+:/.test(firstVal)) {
          issues.push({ type: 'warn', node: n.id, msg: `Node "${d.label}" (${n.id}): Label column "${d.labelColumn}" looks like a URI ("${firstVal.slice(0,30)}") – possibly ID and label swapped?` })
        }
      }
    }

    // 4. Orphan nodes (no edges) – skip dot-one midpoints
    const connected = new Set()
    for (const e of allEdges) { connected.add(e.source); connected.add(e.target) }
    for (const n of allNodes) {
      if (n.type === 'dotOneMidpoint') continue
      if (!connected.has(n.id)) {
        issues.push({ type: 'info', node: n.id, msg: `Node "${n.data?.label}" (${n.id}): not connected to any other node` })
      }
    }

    // 5. Edges with widened properties (ontology check)
    for (const e of allEdges) {
      const src = allNodes.find(n => n.id === e.source)
      if (!src?.data?.uri || !e.data?.propertyUri) continue
      try {
        // Check strict mode (no widening)
        const strictResult = await api.getProperties(src.data.uri, '', false)
        const strictUris = new Set(strictResult.properties.map(p => p.uri))
        if (!strictUris.has(e.data.propertyUri)) {
          // Check if it's available with widening
          const widenResult = await api.getProperties(src.data.uri, '', true)
          const widenProp = widenResult.properties.find(p => p.uri === e.data.propertyUri)
          if (widenProp?.widened_from?.length > 0) {
            const from = widenProp.widened_from.map(u => u.split(/[#/]/).pop()).join(', ')
            issues.push({ type: 'warn', node: src.id, msg: `Edge "${e.data.label}" (${src.data.label}→): Widening — property is actually defined on subclass (${from})` })
          } else if (!widenResult.properties.find(p => p.uri === e.data.propertyUri)) {
            issues.push({ type: 'error', node: src.id, msg: `Edge "${e.data.label}" (${src.data.label}→): Property not found in ontology for this subject` })
          }
        }
      } catch (_) {
        // Backend offline or other error – skip this check
      }
    }

    // 6. Cross-table edges without join key
    for (const e of allEdges) {
      const src = allNodes.find(n => n.id === e.source)
      const tgt = allNodes.find(n => n.id === e.target)
      if (!src || !tgt) continue
      const sd = src.data || {}, td = tgt.data || {}
      if (sd.mappedColumn && td.mappedColumn && sd.tableId && td.tableId && sd.tableId !== td.tableId) {
        if (!e.data?.joinColumnSource && !e.data?.joinColumnTarget && !e.data?.joinColumn && !sd.joinColumn && !td.joinColumn) {
          issues.push({ type: 'info', node: src.id, msg: `Edge "${e.data?.label}" (${sd.label}→${td.label}): Cross-table without join key — set in property dialog or edge edit` })
        }
      }
    }

    setVerifyResults(issues)
    if (issues.length === 0) {
      toast.success('✓ No issues found')
    } else {
      const errors = issues.filter(i => i.type === 'error').length
      const warns = issues.filter(i => i.type === 'warn').length
      const infos = issues.filter(i => i.type === 'info').length
      toast.info(`Verification: ${errors} errors, ${warns} warnings, ${infos} hints`)
    }
  }, [liveNodes, rfInstance, toast, languages])

  const handleLoadProject = () => { loadInputRef.current?.click() }

  const handleLoadFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      let legacyLangNote = null
      try {
        const project = JSON.parse(ev.target.result)
        if (!project.nodes || !project.edges) throw new Error('Invalid project format')

        // Re-attach all callbacks – they cannot be serialised to JSON
        const restoredNodes = project.nodes.map(n => ({
          ...n,
          data: { ...n.data, ...nodeCallbacks },
        }))

        setNodes(restoredNodes)

        // ── Migrate edges from old joinColumn to joinColumnSource/joinColumnTarget ──
        const migratedEdges = (project.edges || []).map(e => {
          if (e.data?.joinColumn && !e.data?.joinColumnSource && !e.data?.joinColumnTarget) {
            return { ...e, data: { ...e.data, joinColumnTarget: e.data.joinColumn, joinColumn: undefined } }
          }
          return e
        })
        setEdges(migratedEdges)

        if (project.idPrefix !== undefined) setIdPrefix(project.idPrefix)
        if (project.prefixMap) setPrefixMap(project.prefixMap)
        // v4: split widening; backward compat with v3 single widening flag
        if (project.wideningParent !== undefined) setWideningParent(project.wideningParent)
        if (project.wideningChild !== undefined) setWidening(project.wideningChild)
        else if (project.widening !== undefined) setWidening(project.widening)
        if (project.namedGraphs) setNamedGraphs(project.namedGraphs)
        // Pre-v6 files carry no languages. Everything they hold was written
        // out as @en by a hard-coded tag in the RDF exporter — regardless of
        // what language the text actually was. Those projects therefore load
        // with the current default primary language and say so, rather than
        // silently keeping a tag that was never a decision.
        if (project.languages) {
          const langs = normalizeLanguages(project.languages)
          setLanguages(langs)
          setActiveLang(langs.primary)
        } else {
          setActiveLang(languages.primary)
          legacyLangNote = languages.primary
        }
        // Fix nodeCounter to avoid ID collisions
        const maxId = Math.max(0, ...project.nodes.map(n => parseInt(n.id.replace('n',''))||0))
        nodeCounter = maxId + 1
        setVerifyResults(null)

        // The tables are NOT rebuilt from the file. The rows a project carries
        // are the state of the data when it was saved, and a project is
        // usually re-opened in order to feed it updated tables — so the panel
        // gets one empty placeholder per table the canvas refers to instead.
        // Loading a file into a placeholder reuses its table id, which keeps
        // every column mapping valid; the placeholder also offers the rows
        // stored in the file, for when they *are* what is wanted.
        const stubs = tableStubsFromProject(project)
        window.dispatchEvent(new CustomEvent('tables:placeholders', { detail: stubs }))

        const tableNote = stubs.length > 0
          ? ` · ${stubs.length} table${stubs.length === 1 ? '' : 's'} expected — load them in the Tables panel`
          : ''
        toast.success(`Project loaded: ${project.nodes.length} Nodes, ${project.edges.length} Edges${tableNote}`)
        if (legacyLangNote) {
          toast.info(`Project predates language support — its labels were exported as "@en" regardless of their actual language. They are now written as "@${legacyLangNote}"; change it under the language button if that is wrong.`)
        }
      } catch (err) {
        toast.error('Error loading: ' + err.message)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // Memoised so a re-render doesn't hand every node a fresh context object.
  const languageView = useMemo(() => ({ languages, activeLang }), [languages, activeLang])

  const nodeCount = rfInstance.getNodes().length
  const edgeCount = rfInstance.getEdges().length
  // Derived from the rendered nodes so the button label follows individually
  // collapsed nodes too, not just its own last click.
  const ontologyNodes = nodes.filter(n => n.type === 'ontologyNode')
  const allCollapsed  = ontologyNodes.length > 0 && ontologyNodes.every(n => n.data?.collapsed)

  return (
    <LanguageViewContext.Provider value={languageView}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 16px', height: 42, flexShrink: 0,
        background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/logo.png" alt="OntoCartographer" style={{ height: 28 }} />
          <span style={{ fontFamily: 'var(--font)', fontSize: 14, fontWeight: 600, color: 'var(--text)', letterSpacing: '0.02em' }}>
            <span style={{ color: '#0f97a8' }}>Onto</span><span style={{ color: '#db2777' }}>Cartographer</span>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Studio</span>
          </span>
        </div>
        <div style={{ flex: 1 }} />
        {/* Language switch. One control, two jobs — which is why it is worth a
            slot in an already-full toolbar: it sets the display language for
            every node at once (a per-row chip would mean one click per node),
            and it is where the project's languages are defined, so neither
            the Prefix Manager nor a separate settings dialog had to grow. */}
        <div style={{ position: 'relative' }} ref={langMenuRef}>
          <button className="btn-secondary"
            style={{
              display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
              background: isMultilingual(languages) ? 'rgba(219,39,119,0.1)' : undefined,
              borderColor: isMultilingual(languages) ? 'rgba(219,39,119,0.35)' : undefined,
              color: isMultilingual(languages) ? '#db2777' : undefined,
            }}
            onClick={() => setShowLangMenu(v => !v)}
            title="Label languages — sets the display language for all nodes and defines the project's languages"
          >
            <Languages size={11} />
            <span style={{ fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{activeLang}</span>
            <ChevronDown size={9} style={{ transform: showLangMenu ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
          </button>
          {showLangMenu && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
              minWidth: 190, overflow: 'hidden',
            }}>
              {allLanguages(languages).map(tag => (
                <button key={tag}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px',
                    background: 'transparent', fontSize: 11, textAlign: 'left',
                    color: tag === activeLang ? '#db2777' : 'var(--text)',
                    fontWeight: tag === activeLang ? 600 : 400,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => { setActiveLang(tag); setShowLangMenu(false) }}
                >
                  <span style={{ width: 10, fontSize: 10 }}>{tag === activeLang ? '✓' : ''}</span>
                  <span style={{ fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>{tag}</span>
                  {tag === languages.primary && (
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>primary</span>
                  )}
                </button>
              ))}
              <button
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px',
                  background: 'transparent', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left',
                  borderTop: '1px solid var(--border)',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => { setShowLanguageManager(true); setShowLangMenu(false) }}
              >
                <span style={{ width: 10 }} /> Manage languages…
              </button>
            </div>
          )}
        </div>
        <button className="btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
          onClick={() => {
            setShowPrefixManager(true)
            // Load ontology namespaces for quick-add
            api.getNamespaces().then(r => {
              const ns = r.namespaces || {}
              setOntologyPrefixes(
                Object.entries(ns)
                  .filter(([p, u]) => p && u && !['xml','xmlns'].includes(p))
                  .map(([prefix, namespace]) => ({ prefix, namespace }))
              )
            }).catch(() => {})
          }}
          title="Namespace Prefix Manager – manage the ID prefix and all namespaces"
        >
          <Tag size={11} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{idPrefix || '?'}:</span>
          <span>Prefixes</span>
          <span style={{
            fontSize: 9, padding: '0 4px', borderRadius: 3,
            background: 'var(--accent-glow)', color: 'var(--accent)',
          }}>
            {Object.keys(prefixMap).length}
          </span>
        </button>
        <button className="btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
          onClick={() => setShowFreeNode(v => !v)}
          title="Create free node with custom class (e.g. xsd:date, geo:wktLiteral)"
        >
          <PlusCircle size={11} /> Node
        </button>
        <button className="btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
          onClick={() => handleCollapseAll(!allCollapsed)}
          title={allCollapsed
            ? 'Expand all nodes'
            : 'Collapse all nodes to their class name — nothing is lost, only hidden'}
        >
          {allCollapsed ? <Maximize2 size={11} /> : <Minimize2 size={11} />}
          {allCollapsed ? 'Expand' : 'Collapse'}
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }} onClick={handleSaveProject}>
          <Save size={11} /> Save
        </button>
        <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }} onClick={handleLoadProject}>
          <FolderOpen size={11} /> Load
        </button>
        <input ref={loadInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoadFile} />
        <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
          onClick={() => importInputRef.current?.click()}
          title="Import an existing graph (RDF or Graph Explorer JSON) — one node per class, instances land in a table behind it">
          <FileInput size={11} /> Import
        </button>
        <input ref={importInputRef} type="file" style={{ display: 'none' }}
          accept=".ttl,.rdf,.owl,.xml,.nt,.nq,.trig,.n3,.jsonld,.json"
          onChange={handleImportFile} />
        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <button
          onClick={() => setWideningParent(w => !w)}
          title={wideningParent ? 'Parent Widening ON: Also offers inherited properties from superclasses' : 'Parent Widening OFF: Only direct properties (no inheritance)'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '4px 8px',
            borderRadius: 4, cursor: 'pointer', border: '1px solid',
            background: wideningParent ? 'rgba(25,190,207,0.12)' : 'var(--bg)',
            borderColor: wideningParent ? 'rgba(25,190,207,0.35)' : 'var(--border)',
            color: wideningParent ? 'var(--accent)' : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          <ChevronsDownUp size={10} style={{ transform: 'rotate(180deg)' }} />
          <span>↑ Parent</span>
          <span style={{
            fontSize: 8, padding: '0 4px', borderRadius: 3,
            background: wideningParent ? 'rgba(25,190,207,0.2)' : 'var(--bg-card)',
            color: wideningParent ? 'var(--accent)' : 'var(--text-muted)',
            fontWeight: 600,
          }}>
            {wideningParent ? 'ON' : 'OFF'}
          </span>
        </button>
        <button
          onClick={() => setWidening(w => !w)}
          title={widening ? 'Child Widening ON: Also offers properties from subclasses' : 'Child Widening OFF: No properties from subclasses'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '4px 8px',
            borderRadius: 4, cursor: 'pointer', border: '1px solid',
            background: widening ? 'rgba(255,191,40,0.12)' : 'var(--bg)',
            borderColor: widening ? '#ffbf28' : 'var(--border)',
            color: widening ? 'var(--orange)' : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          <ChevronsDownUp size={10} />
          <span>↓ Child</span>
          <span style={{
            fontSize: 8, padding: '0 4px', borderRadius: 3,
            background: widening ? 'rgba(255,191,40,0.25)' : 'var(--bg-card)',
            color: widening ? 'var(--orange)' : 'var(--text-muted)',
            fontWeight: 600,
          }}>
            {widening ? 'ON' : 'OFF'}
          </span>
        </button>
        <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }} onClick={handleVerify}>
          <ShieldCheck size={11} /> Verify
        </button>
        <button
          className="btn-secondary"
          style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
            background: showGraphPanel ? 'rgba(219,39,119,0.1)' : undefined,
            borderColor: showGraphPanel ? 'rgba(219,39,119,0.35)' : undefined,
            color: showGraphPanel ? '#db2777' : undefined,
          }}
          onClick={() => setShowGraphPanel(v => !v)}
          title="Manage Named Graphs (I4_Proposition_Set)"
        >
          <Group size={11} /> Graphs
          {namedGraphs.length > 0 && (
            <span style={{ fontSize: 9, padding: '0 4px', borderRadius: 3, background: 'rgba(219,39,119,0.15)', color: '#db2777' }}>
              {namedGraphs.length}
            </span>
          )}
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <div style={{ position: 'relative' }} ref={exportMenuRef}>
          <button style={{
              display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500,
              background: 'var(--brand-cyan)', color: 'var(--text)',
              padding: '6px 14px', borderRadius: 'var(--radius)',
              border: '1px solid var(--brand-cyan-edge)',
            }}
            onClick={() => setShowExportMenu(m => !m)}
            title="Export the canvas as GraphML, PNG, SVG or TSV">
            <Download size={11} /> Export
            <ChevronDown size={9} style={{
              transform: showExportMenu ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s',
            }} />
          </button>
          {showExportMenu && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
              minWidth: 170, overflow: 'hidden',
            }}>
              <button style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
                background: 'transparent', color: 'var(--text)', fontSize: 11, textAlign: 'left',
                borderBottom: '1px solid var(--border)',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => { handleExportGraphML(); setShowExportMenu(false) }}>
                <Download size={12} color="var(--text-dim)" />
                <div>
                  <div style={{ fontWeight: 500 }}>GraphML</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>yEd-compatible with colors</div>
                </div>
              </button>
              <button style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
                background: 'transparent', color: 'var(--text)', fontSize: 11, textAlign: 'left',
                borderBottom: '1px solid var(--border)',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => { handleExportImage('png'); setShowExportMenu(false) }}>
                <Image size={12} color="var(--text-dim)" />
                <div>
                  <div style={{ fontWeight: 500 }}>PNG (image)</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Publication-ready, 2× resolution</div>
                </div>
              </button>
              <button style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
                background: 'transparent', color: 'var(--text)', fontSize: 11, textAlign: 'left',
                borderBottom: '1px solid var(--border)',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => { handleExportImage('svg'); setShowExportMenu(false) }}>
                <Image size={12} color="var(--text-dim)" />
                <div>
                  <div style={{ fontWeight: 500 }}>SVG (vector)</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Scalable, editable</div>
                </div>
              </button>
              <button style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
                background: 'transparent', color: 'var(--text)', fontSize: 11, textAlign: 'left',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => { handleExportTSV(); setShowExportMenu(false) }}>
                <FileDown size={12} color="var(--text-dim)" />
                <div>
                  <div style={{ fontWeight: 500 }}>TSV (URI + Literal)</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Fully resolved URIs, 2 files</div>
                </div>
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <select value={rdfExportFormat} onChange={e => setRdfExportFormat(e.target.value)}
            style={{ fontSize: 10, padding: '4px 4px', fontFamily: 'var(--mono)', width: 62, borderRadius: '4px 0 0 4px', borderRight: 'none' }}
            title="Choose RDF export format">
            <option value="trig">TriG</option>
            <option value="nq">N-Quads</option>
            <option value="turtle">Turtle</option>
            <option value="xml">RDF/XML</option>
            <option value="nt">N-Triples</option>
            <option value="jsonld">JSON-LD</option>
          </select>
          <button style={{
              display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, borderRadius: '0 4px 4px 0',
              background: 'var(--brand-pink)', color: '#fff', padding: '6px 14px', fontWeight: 500,
            }}
            onClick={() => handleExportRdf()}
            title="Direct RDF export of all instance data incl. Named Graphs">
            <Download size={11} /> RDF
          </button>
        </div>
        <button
          style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500,
            background: 'var(--brand-yellow)', color: 'var(--text)',
            padding: '6px 14px', borderRadius: 'var(--radius)',
            border: '1px solid var(--brand-yellow-edge)',
          }}
          onClick={handleExploreInGraphExplorer}
          title="Export graph JSON for Graph Explorer (graph-explorer.html)"
        >
          &#9906; Explore
        </button>
      </div>

      {/* Named Graph panel */}
      {showGraphPanel && (
        <div style={{
          background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
          padding: '8px 16px', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: '#db2777', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Named Graphs (I4_Proposition_Set)
            </span>
            <div style={{ flex: 1 }} />
            <input
              placeholder="Graph label (e.g. example:E19_Finds)"
              value={ngLabel}
              onChange={e => setNgLabel(e.target.value)}
              style={{ width: 220, fontSize: 10, padding: '3px 7px', fontFamily: 'var(--mono)' }}
            />
            <button className="btn-primary" style={{ fontSize: 10, padding: '3px 10px' }} onClick={() => {
              if (!ngLabel.trim()) return
              const selectedNodes = rfInstance.getNodes().filter(n => n.selected).map(n => n.id)
              if (selectedNodes.length === 0) { toast.error('Please select nodes in the graph first (Shift+Click or drag a selection box)'); return }
              const ng = { id: `ng_${Date.now()}`, label: ngLabel.trim(), nodeIds: selectedNodes,
                color: ['#0f97a8','#db2777','#14a35c','#a37200','#c94052','#7b68a8'][namedGraphs.length % 6] }
              setNamedGraphs(gs => [...gs, ng])
              setNgLabel('')
              toast.success(`Graph "${ng.label}" created with ${selectedNodes.length} Nodes`)
            }}>
              Selection → Graph
            </button>
          </div>
          {namedGraphs.length === 0 ? (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Select nodes in the graph (Shift+Click or drag), enter a label and click "Selection → Graph"
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {namedGraphs.map(ng => (
                <div key={ng.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                  background: 'var(--bg)', borderRadius: 4, border: `1px solid ${ng.color}33`,
                  cursor: 'pointer',
                }}
                  onClick={(e) => {
                    // Prevent click on child buttons from triggering this
                    if (e.target.closest('button')) return
                    // Select all nodes of this named graph and fit view to them
                    const ngSet = new Set(ng.nodeIds)
                    setNodes(ns => ns.map(n => ({ ...n, selected: ngSet.has(n.id) })))
                    // Compute bounding box and show overlay
                    setTimeout(() => {
                      const matchedNodes = rfInstance.getNodes().filter(n => ngSet.has(n.id))
                      if (matchedNodes.length > 0) {
                        const xs = matchedNodes.map(n => n.position.x)
                        const ys = matchedNodes.map(n => n.position.y)
                        const padding = 40
                        const bounds = {
                          x: Math.min(...xs) - padding,
                          y: Math.min(...ys) - padding,
                          width: Math.max(...xs) - Math.min(...xs) + 260 + padding * 2,
                          height: Math.max(...ys) - Math.min(...ys) + 120 + padding * 2,
                        }
                        setHighlightNg({ nodeIds: ng.nodeIds, color: ng.color, label: ng.label, bounds })
                        rfInstance.fitBounds({
                          x: bounds.x - 40,
                          y: bounds.y - 40,
                          width: bounds.width + 80,
                          height: bounds.height + 80,
                        }, { duration: 300 })
                      }
                    }, 50)
                    toast.info(`${ng.nodeIds.length} nodes from "${ng.label}" selected`)
                  }}
                  title="Click to highlight and show nodes"
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: ng.color, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: ng.color, flex: 1 }}>{ng.label}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{ng.nodeIds.length} Nodes</span>
                  <button className="btn-ghost" style={{ padding: '1px 4px', fontSize: 9, color: 'var(--text-muted)' }}
                    onClick={() => {
                      // Re-select: update nodeIds from currently selected nodes
                      const sel = rfInstance.getNodes().filter(n => n.selected).map(n => n.id)
                      if (sel.length === 0) { toast.error('Please select nodes'); return }
                      setNamedGraphs(gs => gs.map(g => g.id === ng.id ? { ...g, nodeIds: sel } : g))
                      toast.success(`Graph "${ng.label}" updated: ${sel.length} Nodes`)
                    }}
                    title="Update selection"
                  >↻</button>
                  <button className="btn-ghost" style={{ padding: '1px 4px' }}
                    onClick={() => setNamedGraphs(gs => gs.filter(g => g.id !== ng.id))}>
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Free Node creation panel */}
      {showFreeNode && (
        <div style={{
          background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
          padding: '8px 16px', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Free node
            </span>
            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
              Define custom class (e.g. xsd:date, geo:wktLiteral, or any URI)
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn-ghost" style={{ padding: '1px 4px' }} onClick={() => setShowFreeNode(false)}>
              <X size={10} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Class label *</span>
              <input
                value={freeNodeLabel}
                onChange={e => setFreeNodeLabel(e.target.value)}
                placeholder="e.g. xsd:date"
                style={{ width: 180, fontSize: 11, padding: '4px 8px', fontFamily: 'var(--mono)' }}
                onKeyDown={e => e.key === 'Enter' && handleAddFreeNode()}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>URI (optional)</span>
              <input
                value={freeNodeUri}
                onChange={e => setFreeNodeUri(e.target.value)}
                placeholder="e.g. http://www.w3.org/2001/XMLSchema#date"
                style={{ width: 340, fontSize: 11, padding: '4px 8px', fontFamily: 'var(--mono)' }}
                onKeyDown={e => e.key === 'Enter' && handleAddFreeNode()}
              />
            </div>
            <button className="btn-primary" style={{ fontSize: 11, padding: '6px 14px', marginTop: 12 }}
              onClick={handleAddFreeNode}>
              <PlusCircle size={11} style={{ marginRight: 4 }} /> Create
            </button>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>
            Tip: The node will be placed in the center of the graph. Label is used as class name.
            If no URI is specified, the label is used as the URI.
            Prefixes like <code style={{ fontFamily: 'var(--mono)' }}>xsd:</code> are resolved via the Prefix Manager.
          </div>
        </div>
      )}

      {/* Verification results panel */}
      {verifyResults && verifyResults.length > 0 && (
        <div style={{
          background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
          padding: '6px 16px', maxHeight: 160, overflowY: 'auto', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Verification: {verifyResults.length} {verifyResults.length === 1 ? 'issue' : 'issues'}
            </span>
            <button className="btn-ghost" style={{ padding: '1px 4px' }} onClick={() => setVerifyResults(null)}>
              <X size={10} />
            </button>
          </div>
          {verifyResults.map((issue, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '3px 0', fontSize: 11,
              color: issue.type === 'error' ? '#c94052' : issue.type === 'warn' ? '#a37200' : 'var(--text-muted)',
            }}>
              <span style={{ flexShrink: 0, fontSize: 10, marginTop: 1 }}>
                {issue.type === 'error' ? '●' : issue.type === 'warn' ? '▲' : '○'}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{issue.msg}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ width: leftWidth, flexShrink: 0, borderRight: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* Panel switcher — sits directly above the panel it switches, which
              keeps the top bar free for the graph-wide actions. */}
          <div style={{
            display: 'flex', gap: 2, padding: 5, flexShrink: 0,
            background: 'var(--bg)', borderBottom: '1px solid var(--border)',
          }}>
            {[
              { id: PANEL_ONTOLOGY, icon: <Layers size={11} />, label: 'Ontologies' },
              { id: PANEL_TABLE,    icon: <Table  size={11} />, label: 'Tables'  },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActivePanel(tab.id)} style={{
                flex: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                padding: '5px 12px', borderRadius: 4, fontSize: 11,
                background: activePanel === tab.id ? 'var(--bg-card)' : 'transparent',
                color:      activePanel === tab.id ? 'var(--text)'    : 'var(--text-muted)',
                border:     activePanel === tab.id ? '1px solid var(--border)' : '1px solid transparent',
              }}>
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>
          {/* flex:1 + minHeight:0 rather than height:100% — the panels now
              share the column with the switcher above them. */}
          <div style={{ display: activePanel === PANEL_ONTOLOGY ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <OntologyPanel widening={widening} wideningParent={wideningParent} toast={toast} />
          </div>
          <div style={{ display: activePanel === PANEL_TABLE ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <TablePanel
              onAllRowsUpdate={() => {}}
              onTableRefresh={handleTableRefresh}
              onTablesChange={setLiveTables}
              onUseStoredRows={handleUseStoredRows}
              onAssignTable={handleAssignTable}
            />
          </div>
        </div>
        <div className="resize-handle" onMouseDown={onMouseDownResize} />
        <div ref={rfWrapper} style={{ flex: 1, position: 'relative' }} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect} nodeTypes={nodeTypes}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onPaneClick={() => setHighlightNg(null)}
            onMoveEnd={() => {
              // Force re-render of bounding box after pan/zoom
              if (highlightNg) setHighlightNg(h => h ? { ...h } : null)
            }}
            elementsSelectable={true}
            fitView deleteKeyCode="Delete"
            // ReactFlow's default floor of 0.5 is far too high here: an
            // imported graph easily spans several thousand pixels, and fitView
            // silently clamps to the floor — leaving the user on a fragment of
            // a layout that is in fact perfectly ordered.
            minZoom={0.02}
            maxZoom={2.5}
            fitViewOptions={{ padding: 0.15, minZoom: 0.02, maxZoom: 1.5 }}
            defaultEdgeOptions={{ focusable: true, style: EDGE_STYLE }}
          >
            <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={22} size={1} />
            <Controls />
            <MiniMap nodeColor={n => n.data?.nodeColor || '#cccccc'} maskColor="rgba(240,245,246,0.85)"
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }} />
          </ReactFlow>
          {highlightNg && highlightNg.bounds && (
            <BoundingBoxOverlay bounds={highlightNg.bounds} color={highlightNg.color} label={highlightNg.label} rfInstance={rfInstance} />
          )}
          {nodeCount > 0 && (
            <div style={{
              position: 'absolute', bottom: 12, left: 12,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '3px 10px',
              fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)', pointerEvents: 'none',
            }}>
              {nodeCount} Nodes · {edgeCount} Edges
              {edges.some(e => e.selected) && (
                <span style={{ color: '#db2777', marginLeft: 8 }}>
                  ⊙ Edge selected — drag a class here for Dot-One
                </span>
              )}
            </div>
          )}
          {nodeCount === 0 && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', gap: 12,
            }}>
              <img src="/logo.png" alt="OntoCartographer" style={{ height: 100, opacity: 0.8 }} />
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', lineHeight: 2.2 }}>
                <div style={{ fontSize: 14, color: 'var(--text-dim)' }}>Conceptual Graph</div>
                <div style={{ fontSize: 11 }}>① Load ontology → ② Select subject → ③ Drag node here</div>
                <div style={{ fontSize: 10 }}>Select node → Drop object = automatic linking</div>
                <div style={{ fontSize: 10 }}>Draw connection between nodes → Property selection from ontology</div>
                <div style={{ fontSize: 10 }}>Click edge + drag class onto it = Dot-One · Double-click edge = edit</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {pendingConnect && (
        <PropertyPickerModal
          sourceNode={pendingConnect.sourceNode}
          targetNode={pendingConnect.targetNode}
          onConfirm={handlePropertyChosen}
          onCancel={() => setPendingConnect(null)}
          widening={widening}
          wideningParent={wideningParent}
        />
      )}

      {editingEdge && (
        <EdgeEditModal
          edge={editingEdge.edge}
          sourceNode={editingEdge.sourceNode}
          targetNode={editingEdge.targetNode}
          onConfirm={handleEdgeUpdate}
          onCancel={() => setEditingEdge(null)}
        />
      )}

      {importPreview && (
        <ImportGraphModal
          payload={importPreview.payload}
          fileName={importPreview.fileName}
          onConfirm={handleImportConfirm}
          onCancel={() => setImportPreview(null)}
        />
      )}

      {changingClass && (
        <ClassChangeModal
          node={changingClass.node}
          outgoingEdges={changingClass.outgoingEdges}
          connectionCount={changingClass.connectionCount}
          widening={widening}
          wideningParent={wideningParent}
          onConfirm={handleClassChangeConfirm}
          onCancel={() => setChangingClass(null)}
        />
      )}

      {pendingDotOne && (
        <DotOneModal
          edge={pendingDotOne.edge}
          sourceNode={pendingDotOne.sourceNode}
          targetNode={pendingDotOne.targetNode}
          dotItem={pendingDotOne.dotItem}
          onConfirm={handleDotOneConfirm}
          onCancel={() => setPendingDotOne(null)}
        />
      )}


      {showPrefixManager && (
        <PrefixManagerModal
          prefixMap={prefixMap}
          idPrefix={idPrefix}
          onSave={handlePrefixSave}
          onClose={() => setShowPrefixManager(false)}
          ontologyPrefixes={ontologyPrefixes}
          tableData={tableData}
          nodes={liveNodes}
        />
      )}

      {showLanguageManager && (
        <LanguageManagerModal
          languages={languages}
          nodes={liveNodes}
          onSave={handleLanguagesSave}
          onClose={() => setShowLanguageManager(false)}
        />
      )}
    </div>
    </LanguageViewContext.Provider>
  )
}

export default function App() {
  const { toasts, toast } = useToast()
  const [activePanel, setActivePanel] = useState(PANEL_ONTOLOGY)
  const [leftWidth,   setLeftWidth]   = useState(280)
  const [tableData,   setTableData]   = useState([])
  const [idPrefix,  setIdPrefix]  = useState('your_prefix')
  // Project languages, and the canvas-wide display language (view state only,
  // never saved). Defaults to a single language, which renders exactly the
  // pre-3.1 UI — the language chips only appear once a second one is added.
  const [languages, setLanguages]   = useState(DEFAULT_LANGUAGES)
  const [activeLang, setActiveLang] = useState(DEFAULT_LANGUAGES.primary)
  const [wideningParent, setWideningParent] = useState(true)
  const [wideningChild, setWideningChild] = useState(false)
  const [prefixMap, setPrefixMap] = useState({
    'crm':        'http://www.cidoc-crm.org/cidoc-crm/',
    'crmarchaeo': 'http://www.cidoc-crm.org/extensions/crmarchaeo/',
    'crmsci':     'http://www.cidoc-crm.org/extensions/crmsci/',
    'lrmoo':      'http://www.cidoc-crm.org/extensions/lrmoo/',
    'rdf':        'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'rdfs':       'http://www.w3.org/2000/01/rdf-schema#',
    'owl':        'http://www.w3.org/2002/07/owl#',
    'xsd':        'http://www.w3.org/2001/XMLSchema#',
  })
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const resizing = useRef(false)
  const startX   = useRef(0)
  const startW   = useRef(0)

  const onMouseDownResize = (e) => {
    resizing.current = true; startX.current = e.clientX; startW.current = leftWidth
    const onMove = (ev) => {
      if (!resizing.current) return
      setLeftWidth(Math.max(200, Math.min(500, startW.current + ev.clientX - startX.current)))
    }
    const onUp = () => {
      resizing.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <ReactFlowProvider>
      <GraphInner
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        setNodes={setNodes} setEdges={setEdges}
        toast={toast} tableData={tableData}
        activePanel={activePanel} setActivePanel={setActivePanel}
        leftWidth={leftWidth} onMouseDownResize={onMouseDownResize}
        idPrefix={idPrefix} setIdPrefix={setIdPrefix}
        prefixMap={prefixMap} setPrefixMap={setPrefixMap}
        widening={wideningChild} setWidening={setWideningChild}
        wideningParent={wideningParent} setWideningParent={setWideningParent}
        languages={languages} setLanguages={setLanguages}
        activeLang={activeLang} setActiveLang={setActiveLang}
      />
      <ToastContainer toasts={toasts} />
    </ReactFlowProvider>
  )
}

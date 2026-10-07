/**
 * graphImport.js — turn the backend's /import/graph payload into canvas
 * nodes, edges and tables.
 *
 * Deliberately pure: no React, no styling, no callbacks. The caller decorates
 * the edges with the usual style/marker and attaches the node callbacks, which
 * keeps this whole translation unit testable outside the browser.
 *
 * The result is made of ORDINARY mapped nodes — the same shape a CSV upload
 * plus a column drag produces. Nothing downstream (class change, edge editing,
 * verification, GraphML / RDF / Graph-Explorer export) needs to know that the
 * graph came from an import.
 *
 * Three subtleties decide whether the export stays exact:
 *
 * 1. A relation joins `srcRow[<predicate column>] == tgtRow["uri"]`, which the
 *    export resolves through its explicit 2-key join and deduplicates on the
 *    (domain, range) pair — so the identity columns repeated across a
 *    multi-valued instance's rows cannot produce duplicate triples.
 *
 * 2. A SELF-relation (domain class == range class) would otherwise put both
 *    ends on the same table, and the export treats "same table" as a
 *    row-by-row zip — which would pair every instance with ITSELF instead of
 *    following the relation. Such relations therefore get a second, distinct
 *    role node bound to a slim identity table (uri + label only). Its column
 *    signature differs from the full table, so the zip heuristic correctly
 *    declines and the join runs instead.
 *
 * 3. An RDF-star annotation becomes a real Dot-One: the relation is split
 *    through a midpoint node exactly as the manual Dot-One flow builds it, and
 *    the qualifier node is mapped to the annotation column ON THE DOMAIN
 *    TABLE. That is what lets the export resolve the value per row (via the
 *    table-id match) instead of falling back to a single static value.
 */

import dagre from 'dagre'

const LITERAL_DATATYPE_FALLBACK = 'http://www.w3.org/2001/XMLSchema#string'

// Roughly the rendered size of an ontology node — dagre needs it to keep
// ranks apart; the exact value only affects spacing, not correctness.
const NODE_W = 250
const NODE_H = 150

function looksLikeUri(value) {
  return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))
}

// Mirrors the free-node colour heuristic: literal/geometry classes are not in
// the ontology, so the CIDOC superclass walk cannot colour them.
function literalColor(uri) {
  const u = String(uri || '')
  if (u.includes('XMLSchema') || u.startsWith('xsd:')) return '#86bcc8'
  if (u.includes('geosparql') || u.startsWith('geo:')) return '#94cc7d'
  return '#e8e8e8'
}

/**
 * Layered left-to-right layout over the structural graph. A grid sorted by
 * instance count says nothing about how the classes relate; dagre puts every
 * connection's source left of its target, which is what makes a property chain
 * readable at a glance.
 */
function layout(nodes, edges) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 70, ranksep: 260, marginx: 60, marginy: 60, ranker: 'tight-tree' })
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target) && e.source !== e.target) g.setEdge(e.source, e.target)
  }
  dagre.layout(g)
  for (const n of nodes) {
    const p = g.node(n.id)
    if (p) n.position = { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) }
  }
}

function overlaps(a, b) {
  return Math.abs(a.x - b.x) < NODE_W + 30 && Math.abs(a.y - b.y) < NODE_H + 30
}

/**
 * Place a hand-positioned node at `wanted`, sliding it downwards until it no
 * longer collides with anything already placed. Only the Dot-One qualifiers
 * are positioned by hand (they belong next to their midpoint, not in the rank
 * dagre would give them), so this short pass is all the collision handling the
 * layout needs.
 */
function placeClear(wanted, placed) {
  const pos = { ...wanted }
  for (let guard = 0; guard < 60 && placed.some(p => overlaps(pos, p)); guard++) {
    pos.y += 60
  }
  return pos
}

/**
 * @param payload  the /import/graph response
 * @param makeId   () => string, hands out canvas-unique node ids
 * @returns { nodes, edges, tables, summary }
 */
export function buildImportedGraph(payload, makeId) {
  const classes   = payload?.classes   || []
  const relations = payload?.relations || []
  const literals  = payload?.literals  || []

  const nodes  = []
  const edges  = []
  const tables = []

  const classNodeId = {}   // class uri -> node id
  const classInfo   = {}   // class uri -> the payload entry
  const tableIdOf   = {}   // class uri -> canvas-unique table id

  // The backend numbers its tables per request ("imp_1", …). Importing a
  // second graph would otherwise reuse those ids and make nodes from the two
  // imports look like they share a table — which the export's join logic reads
  // as "same source", silently changing how their edges are resolved.
  const runId = Date.now().toString(36)

  const selfRelated = new Set(
    relations.filter(r => r.domain_class === r.range_class).map(r => r.domain_class)
  )

  const litsOf = {}
  for (const lit of literals) (litsOf[lit.domain_class] = litsOf[lit.domain_class] || []).push(lit)

  // ── Class nodes + their tables ────────────────────────────────────────────
  for (const cls of classes) {
    const id = makeId()
    classNodeId[cls.class_uri] = id
    classInfo[cls.class_uri]   = cls
    tableIdOf[cls.class_uri]   = `${cls.table_id}_${runId}`

    nodes.push({
      id,
      type: 'ontologyNode',
      position: { x: 0, y: 0 },        // replaced by layout() below
      data: {
        label:         cls.label,
        uri:           cls.class_uri,
        nodeType:      'subject',
        rdfs_label:    '',
        nodeColor:     '#e8e8e8',
        mappedColumn:  cls.id_column,
        labelColumn:   cls.label_column,
        tableId:       tableIdOf[cls.class_uri],
        // Kept on the node so a project saved from an import can match the
        // table again when it is loaded in a later session.
        tableName:     cls.table_name,
        tableRows:     cls.rows,
        instanceLabel: '',
        // Imported ids are already full URIs — the project's ID prefix must
        // not be prepended. Opaque ids (a Graph-Explorer JSON may use
        // "B_1989_2") do need it to become resolvable, so the backend decides.
        noPrefix:      !!cls.no_prefix,
        explorerLabel: '',
        isFreeNode:    !looksLikeUri(cls.class_uri),
        importedFrom:  payload?.source || 'import',
      },
    })

    tables.push({
      name:    cls.table_name,
      tableId: tableIdOf[cls.class_uri],
      headers: cls.headers,
      rows:    cls.rows.slice(0, 10),
      allRows: cls.rows,
    })
  }

  // ── Role nodes + slim identity tables for self-relations ──────────────────
  const roleNodeId = {}
  for (const classUri of selfRelated) {
    const cls = classInfo[classUri]
    const src = nodes.find(n => n.id === classNodeId[classUri])
    if (!cls || !src) continue
    const id  = makeId()
    const tid = `${tableIdOf[classUri]}_id`
    const rows = []
    const seen = new Set()
    for (const r of cls.rows) {
      if (!r.uri || seen.has(r.uri)) continue
      seen.add(r.uri)
      rows.push({ uri: r.uri, label: r.label })
    }
    roleNodeId[classUri] = id
    nodes.push({
      id,
      type: 'ontologyNode',
      position: { x: 0, y: 0 },
      data: { ...src.data, mappedColumn: 'uri', labelColumn: 'label', tableId: tid, tableName: `${cls.label} · target role`, tableRows: rows, explorerLabel: '' },
    })
    tables.push({ name: `${cls.label} · target role`, tableId: tid, headers: ['uri', 'label'], rows: rows.slice(0, 10), allRows: rows })
  }

  // ── Relation edges (annotated ones are split further down) ────────────────
  const annotated = []
  for (const rel of relations) {
    const source = classNodeId[rel.domain_class]
    const isSelf = rel.domain_class === rel.range_class
    const target = isSelf ? roleNodeId[rel.range_class] : classNodeId[rel.range_class]
    if (!source || !target) continue
    const edge = {
      id: `imp_e_${source}_${target}_${edges.length}`,
      source, target,
      sourceHandle: 'r-s', targetHandle: 'l-t',
      label: rel.label,
      data: {
        label:            rel.label,
        propertyUri:      rel.property_uri,
        joinColumnSource: rel.join_column,
        joinColumnTarget: 'uri',
        explorerLabel:    '',
      },
    }
    edges.push(edge)
    if (rel.dot_one) annotated.push({ edge, rel })
  }

  // ── Literal nodes: same table as their subject → row-by-row zip on export ─
  for (const [classUri, lits] of Object.entries(litsOf)) {
    const cls   = classInfo[classUri]
    const srcId = classNodeId[classUri]
    if (!cls || !srcId) continue
    for (const lit of lits) {
      const id = makeId()
      const datatype = lit.datatype || LITERAL_DATATYPE_FALLBACK
      nodes.push({
        id,
        type: 'ontologyNode',
        position: { x: 0, y: 0 },
        data: {
          label:         lit.datatype_label || datatype,
          uri:           datatype,
          nodeType:      'object',
          rdfs_label:    '',
          nodeColor:     literalColor(datatype),
          mappedColumn:  lit.column,
          labelColumn:   null,
          tableId:       tableIdOf[classUri],
          tableName:     cls.table_name,
          tableRows:     cls.rows,
          instanceLabel: '',
          noPrefix:      true,          // a literal value never takes the ID prefix
          // The bare datatype reads poorly in the Explorer; the predicate name
          // is what the value actually means.
          explorerLabel: lit.label || '',
          isFreeNode:    true,
          importedFrom:  payload?.source || 'import',
        },
      })
      edges.push({
        id: `imp_l_${srcId}_${id}`,
        source: srcId, target: id,
        sourceHandle: 'r-s', targetHandle: 'l-t',
        label: lit.label,
        data: { label: lit.label, propertyUri: lit.property_uri, explorerLabel: '' },
      })
    }
  }

  // ── Dot-One qualifier nodes (one per annotated relation) ──────────────────
  // Deliberately kept OUT of the dagre run: a qualifier belongs visually next
  // to the midpoint of its relation, and dagre would instead give it a rank of
  // its own one column further right — leaving the dot-one edge to cut back
  // across the whole diagram. They are placed by hand once the midpoints are
  // known (see placeClear below).
  for (const a of annotated) {
    const cls = classInfo[a.rel.domain_class]
    const id  = makeId()
    a.dotNodeId = id
    nodes.push({
      id,
      type: 'ontologyNode',
      position: { x: 0, y: 0 },
      data: {
        label:         a.rel.dot_one.label,
        uri:           a.rel.dot_one.property_uri,
        nodeType:      'object',
        rdfs_label:    '',
        nodeColor:     '#fab565',       // E55_Type-ish: a qualifier is a type
        mappedColumn:  a.rel.dot_one.column,
        labelColumn:   null,
        tableId:       tableIdOf[a.rel.domain_class],
        tableName:     cls.table_name,
        tableRows:     cls.rows,
        instanceLabel: '',
        noPrefix:      true,            // the qualifier value is already a URI
        explorerLabel: '',
        isFreeNode:    true,
        importedFrom:  payload?.source || 'import',
      },
    })
  }

  const qualifierIds = new Set(annotated.map(a => a.dotNodeId))
  layout(nodes.filter(n => !qualifierIds.has(n.id)), edges)

  // ── Split every annotated relation into the Dot-One shape ─────────────────
  // Source ──seg1──▶ Midpoint ──seg2──▶ Target
  //                      └──dot1──▶ Qualifier
  // On export seg1 carries the property plus the Dot-One metadata; seg2 and
  // dot1 are skipped. Identical to what handleDotOneConfirm builds by hand.
  const midpoints = []
  const placed = nodes.filter(n => !qualifierIds.has(n.id)).map(n => n.position)
  for (const a of annotated) {
    const { edge, rel, dotNodeId } = a
    const src = nodes.find(n => n.id === edge.source)
    const tgt = nodes.find(n => n.id === edge.target)
    const dot = nodes.find(n => n.id === dotNodeId)
    const midId = `mid_imp_${dotNodeId}`

    const mid = {
      x: Math.round(((src?.position.x ?? 0) + (tgt?.position.x ?? 0)) / 2 + NODE_W / 2 - 7),
      y: Math.round(((src?.position.y ?? 0) + (tgt?.position.y ?? 0)) / 2 + NODE_H / 2 - 7),
    }
    midpoints.push({
      id: midId,
      type: 'dotOneMidpoint',
      position: mid,
      data: { parentEdgeLabel: rel.label },
      draggable: true, width: 14, height: 14,
    })
    if (dot) {
      dot.position = placeClear({ x: mid.x - Math.round(NODE_W / 2), y: mid.y + 130 }, placed)
      placed.push(dot.position)
    }

    edge.target       = midId
    edge.targetHandle = 'mid-t-l'
    edge.data = {
      ...edge.data,
      isSplitSeg1:    true,
      originalTarget: tgt ? tgt.id : edge.target,
      dotOneProp:     rel.dot_one.label,
      dotOnePropUri:  rel.dot_one.property_uri,
      dotOneNodeId:   dotNodeId,
      dotOneEdgeId:   `${edge.id}_dot1`,
    }
    edges.push({
      id: `${edge.id}_seg2`,
      source: midId, target: a.rel.domain_class === a.rel.range_class ? roleNodeId[rel.range_class] : classNodeId[rel.range_class],
      sourceHandle: 'mid-s-r', targetHandle: 'l-t',
      label: '',
      data: { isSplitSeg2: true },
    })
    edges.push({
      id: `${edge.id}_dot1`,
      source: midId, target: dotNodeId,
      sourceHandle: 'dot-s', targetHandle: 't-t',
      label: rel.dot_one.label,
      data: { label: rel.dot_one.label, isDotOne: true },
    })
  }
  nodes.push(...midpoints)

  return {
    nodes, edges, tables,
    summary: {
      ...(payload?.stats || {}),
      node_count:     nodes.length,
      edge_count:     edges.length,
      table_count:    tables.length,
      self_relations: selfRelated.size,
      dot_one_edges:  annotated.length,
      warnings:       payload?.warnings || [],
      source:         payload?.source || 'import',
    },
  }
}

/**
 * collapse.js — hide the nodes that hang off a collapsed parent.
 *
 * Pure and side-effect free, so the rule can be tested without a canvas.
 *
 * ── The ownership rule ──────────────────────────────────────────────────────
 * The canvas is a general directed graph, not a tree: a node can have several
 * parents, chains can run deep, and cycles exist (stratigraphic relations point
 * back at their own class). "Hide everything downstream" would therefore make
 * nodes disappear that a completely unrelated, still-visible parent depends on.
 *
 * A node is hidden only when EVERY connection into it comes from the collapsed
 * node or from something already hidden — i.e. when the collapsed node is its
 * sole owner. Consequences, all of them intentional:
 *
 *   - Leaves hanging off one parent (literal values, Dot-One qualifiers,
 *     identifiers) disappear, which is the case that actually clutters a graph.
 *   - Deep chains collapse too, as long as each step is exclusively owned —
 *     the fixpoint below keeps hiding until nothing changes. So a parent whose
 *     children have children of their own still works.
 *   - A node shared with another parent STAYS VISIBLE. It would otherwise
 *     vanish from a part of the graph that has nothing to do with the click.
 *   - Nodes in a cycle stay visible: each keeps an incoming edge from a node
 *     that is itself not hidden, so the rule never reaches them. Conservative
 *     on purpose — better a node too many than a silently lost one.
 *
 * Hiding is display only. ReactFlow keeps hidden nodes in its store, so
 * `getNodes()` and with it every export sees the full graph unchanged.
 */

/** Ignore self-loops: a node must not block its own hiding. */
function inSources(edges) {
  const map = new Map()
  for (const e of edges) {
    if (e.source === e.target) continue
    if (!map.has(e.target)) map.set(e.target, [])
    map.get(e.target).push(e.source)
  }
  return map
}

export function computeCollapse(nodes, edges) {
  const nodeIds = new Set(nodes.map(n => n.id))
  const roots = new Set(nodes.filter(n => n.data?.childrenCollapsed).map(n => n.id))
  const incoming = inSources(edges)

  // A node is worth offering a collapse button when at least one of its direct
  // children is exclusively its own. O(edges) rather than a search per node.
  const collapsible = new Set()
  for (const e of edges) {
    if (e.source === e.target || !nodeIds.has(e.target)) continue
    const sources = incoming.get(e.target) || []
    if (sources.length === 1 && sources[0] === e.source) collapsible.add(e.source)
  }

  const hidden = new Set()
  if (roots.size > 0) {
    // Fixpoint from below: repeat until a pass hides nothing new. Each pass can
    // only add, so this terminates after at most one pass per node.
    for (let guard = 0; guard <= nodes.length; guard++) {
      let grew = false
      for (const n of nodes) {
        if (roots.has(n.id) || hidden.has(n.id)) continue
        const sources = incoming.get(n.id)
        if (!sources || sources.length === 0) continue
        if (sources.every(s => roots.has(s) || hidden.has(s))) {
          hidden.add(n.id)
          grew = true
        }
      }
      if (!grew) break
    }
  }

  const hiddenEdges = new Set()
  for (const e of edges) {
    if (hidden.has(e.source) || hidden.has(e.target)) hiddenEdges.add(e.id)
  }

  // How many nodes each collapsed parent is actually hiding — shown on its
  // badge so the count is never a guess.
  const outgoing = new Map()
  for (const e of edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, [])
    outgoing.get(e.source).push(e.target)
  }
  const countByRoot = {}
  for (const root of roots) {
    const seen = new Set()
    const queue = [...(outgoing.get(root) || [])]
    while (queue.length) {
      const id = queue.pop()
      if (seen.has(id) || !hidden.has(id)) continue
      seen.add(id)
      for (const next of (outgoing.get(id) || [])) queue.push(next)
    }
    countByRoot[root] = seen.size
  }

  return { hidden, hiddenEdges, countByRoot, collapsible }
}

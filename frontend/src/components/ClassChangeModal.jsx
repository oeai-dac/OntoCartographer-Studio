import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Search, X, Shapes, ArrowRight, Info, AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react'
import { api } from '../utils/api.js'
import { isFoldedLiteralClass } from '../utils/graphml.js'

/**
 * Re-class an existing node: swap ONLY its ontology class (label + URI +
 * rdfs_label + colour).  Everything else on the node — its ID/label column
 * mapping, instance label, Explorer name, literal flag, position and above all
 * its edges — is left untouched by the caller, so the change flows through the
 * project file, the GraphML/JSON and the RDF export as a pure type replacement.
 *
 * The property check below is advisory only: it reports which outgoing
 * connections would no longer be defined for the new class, but never blocks
 * or alters them (same rule the "Verify" pass applies to the whole graph).
 */
export default function ClassChangeModal({
  node,
  outgoingEdges = [],
  connectionCount = 0,
  widening = false,
  wideningParent = true,
  onConfirm,
  onCancel,
}) {
  const d            = node?.data || {}
  const currentUri   = d.uri || ''
  const currentLabel = d.label || ''

  const [classes,   setClasses]   = useState([])
  const [loading,   setLoading]   = useState(false)
  const [search,    setSearch]    = useState('')
  const [selected,  setSelected]  = useState(null)
  const [mode,      setMode]      = useState('list')   // 'list' | 'custom'
  const [customLabel, setCustomLabel] = useState('')
  const [customUri,   setCustomUri]   = useState('')
  const [infoUri,   setInfoUri]   = useState(null)
  const [propCheck, setPropCheck] = useState(null)     // { loading, invalid: [] }
  const searchRef = useRef(null)

  useEffect(() => {
    setLoading(true)
    api.getClasses()
      .then(r => setClasses(r.classes || []))
      .catch(() => setClasses([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { setTimeout(() => searchRef.current?.focus(), 50) }, [])

  // ── Advisory check: which outgoing properties are undefined for the new class?
  useEffect(() => {
    const uri = selected?.uri
    if (!uri || outgoingEdges.length === 0) { setPropCheck(null); return }
    let cancelled = false
    setPropCheck({ loading: true, invalid: [] })
    api.getProperties(uri, '', widening, wideningParent)
      .then(r => {
        if (cancelled) return
        const known = new Set((r.properties || []).map(p => p.uri))
        const invalid = []
        for (const e of outgoingEdges) {
          const pUri = e.data?.propertyUri
          if (!pUri || known.has(pUri)) continue
          const lbl = e.data?.label || e.label || pUri
          if (!invalid.includes(lbl)) invalid.push(lbl)
        }
        setPropCheck({ loading: false, invalid })
      })
      .catch(() => { if (!cancelled) setPropCheck(null) })
    return () => { cancelled = true }
  }, [selected, outgoingEdges, widening, wideningParent])

  // ── Filter + group the class list relative to the current class ─────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = classes.filter(c => c.uri !== currentUri)
    if (!q) return list
    return list.filter(c =>
      c.label.toLowerCase().includes(q) ||
      (c.rdfs_label && c.rdfs_label.toLowerCase().includes(q)) ||
      c.uri.toLowerCase().includes(q)
    )
  }, [classes, search, currentUri])

  const { subclasses, superclasses, others } = useMemo(() => {
    const current   = classes.find(c => c.uri === currentUri)
    const ancestors = new Set(current?.parents || [])
    const sub = [], sup = [], oth = []
    for (const c of filtered) {
      if ((c.parents || []).includes(currentUri)) sub.push(c)
      else if (ancestors.has(c.uri))              sup.push(c)
      else                                        oth.push(c)
    }
    return { subclasses: sub, superclasses: sup, others: oth }
  }, [filtered, classes, currentUri])

  const newUri   = mode === 'custom' ? (customUri.trim() || customLabel.trim()) : (selected?.uri || '')
  const newLabel = mode === 'custom' ? customLabel.trim() : (selected?.label || '')
  const canConfirm = mode === 'custom' ? !!customLabel.trim() : !!selected

  // Literal mode is deliberately NOT touched automatically (the whole point is
  // that only the type changes) — but a mismatch would silently corrupt the
  // export, so point it out.
  const newIsLiteral = !!newUri && isFoldedLiteralClass(newUri)
  const literalHint =
    newIsLiteral && !d.noPrefix  ? 'The new class is a literal type — consider switching "Literal (no prefix)" ON on the node afterwards.' :
    !newIsLiteral && d.noPrefix  ? 'The node has "Literal (no prefix)" ON, but the new class is not a literal type — consider switching it OFF afterwards.' :
    null

  const preserved = [
    connectionCount > 0 && `${connectionCount} connection${connectionCount === 1 ? '' : 's'}`,
    d.mappedColumn  && `ID column "${d.mappedColumn}"`,
    d.labelColumn   && `Label column "${d.labelColumn}"`,
    d.instanceLabel && `Label "${d.instanceLabel}"`,
    d.explorerLabel && `Explorer name "${d.explorerLabel}"`,
    d.noPrefix      && 'Literal mode',
  ].filter(Boolean)

  const handleConfirm = () => {
    if (mode === 'custom') {
      const label = customLabel.trim()
      if (!label) return
      onConfirm({ label, uri: customUri.trim() || label, rdfs_label: label, isFreeNode: true })
      return
    }
    if (!selected) return
    onConfirm({
      label:      selected.label,
      uri:        selected.uri,
      rdfs_label: selected.rdfs_label || '',
      isFreeNode: false,
    })
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { if (infoUri) setInfoUri(null); else onCancel() }
    if (e.key === 'Enter' && canConfirm && !infoUri) handleConfirm()
  }

  const renderClassRow = (c) => {
    const isSel = mode === 'list' && selected?.uri === c.uri
    return (
      <div key={c.uri}>
        <button
          onClick={() => { setSelected(c); setMode('list') }}
          onDoubleClick={() => { setSelected(c); setMode('list'); setTimeout(handleConfirm, 0) }}
          style={{
            width: '100%', textAlign: 'left', padding: '7px 14px',
            background: isSel ? 'var(--accent-glow)' : 'transparent',
            border: 'none', cursor: 'pointer',
            borderLeft: isSel ? '2px solid var(--accent)' : '2px solid transparent',
            display: 'flex', flexDirection: 'column', gap: 2, transition: 'background 0.1s',
          }}
          onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: isSel ? 'var(--accent)' : 'var(--text)' }}>
              {c.label}
            </span>
            {(c.rdfs_comment || c.rdfs_label) && (
              <button
                onClick={(e) => { e.stopPropagation(); setInfoUri(infoUri === c.uri ? null : c.uri) }}
                style={{
                  background: infoUri === c.uri ? 'var(--accent-glow)' : 'transparent',
                  border: '1px solid', borderColor: infoUri === c.uri ? 'var(--accent-dim)' : 'var(--border)',
                  borderRadius: 3, padding: '0 3px', cursor: 'pointer', display: 'flex', alignItems: 'center',
                  color: infoUri === c.uri ? 'var(--accent)' : 'var(--text-muted)',
                }}
                title="Show definition"
              >
                <Info size={9} />
              </button>
            )}
          </div>
          {c.rdfs_label && <span style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 2 }}>{c.rdfs_label}</span>}
        </button>
        {infoUri === c.uri && (c.rdfs_comment || c.rdfs_label) && (
          <div style={{
            padding: '8px 14px 8px 18px', fontSize: 10, color: 'var(--text-dim)',
            background: 'rgba(25,190,207,0.06)', borderLeft: '2px solid var(--accent)',
            lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
          }}>
            {c.rdfs_comment || c.rdfs_label}
          </div>
        )}
      </div>
    )
  }

  const groupHeader = (text, icon, color) => (
    <div style={{
      padding: '5px 14px 3px', fontSize: 9, color: color || 'var(--text-muted)',
      letterSpacing: '0.08em', textTransform: 'uppercase', background: 'var(--bg-card)',
      borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 4,
    }}>
      {icon}{text}
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-bright)', borderRadius: 10, width: 540, maxHeight: '84vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.6)', animation: 'modalIn 0.15s ease' }}
        onKeyDown={handleKeyDown}>

        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shapes size={14} color="var(--accent)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Change class</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{currentLabel || '—'}</span>
              <ArrowRight size={10} />
              <span style={{ fontFamily: 'var(--mono)', color: newLabel ? 'var(--accent)' : 'var(--text-muted)' }}>
                {newLabel || 'select new class…'}
              </span>
            </div>
          </div>
          <button className="btn-ghost" style={{ padding: '3px 6px' }} onClick={onCancel}><X size={13} /></button>
        </div>

        {/* Search */}
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input ref={searchRef} placeholder="Search class…" value={search}
              onChange={e => { setSearch(e.target.value); setMode('list') }} style={{ paddingLeft: 28, paddingRight: 10 }} />
          </div>
        </div>

        {/* Class list */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 100 }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Loading classes…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
              {classes.length === 0 ? 'No ontology loaded — use free input below' : 'No classes found'}
            </div>
          ) : (
            <>
              {subclasses.length > 0 && (<>
                {groupHeader(`Subclasses of ${currentLabel} (${subclasses.length})`, <ArrowDown size={9} />, 'var(--green)')}
                {subclasses.map(renderClassRow)}
              </>)}
              {superclasses.length > 0 && (<>
                {groupHeader(`Superclasses of ${currentLabel} (${superclasses.length})`, <ArrowUp size={9} />, 'var(--text-muted)')}
                {superclasses.map(renderClassRow)}
              </>)}
              {others.length > 0 && (<>
                {groupHeader(`All other classes (${others.length})`, null, 'var(--text-muted)')}
                {others.map(renderClassRow)}
              </>)}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>

          {/* What survives the change */}
          <div style={{
            fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '4px 8px',
          }}>
            Only the class is replaced. Kept unchanged:{' '}
            <span style={{ color: 'var(--text-dim)' }}>
              {preserved.length > 0 ? preserved.join(' · ') : 'position and node settings'}
            </span>
          </div>

          {/* Advisory: outgoing properties undefined for the new class */}
          {propCheck && !propCheck.loading && propCheck.invalid.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              fontSize: 9, color: '#a37200', lineHeight: 1.5,
              background: 'rgba(255,191,40,0.08)', border: '1px solid rgba(163,114,0,0.25)',
              borderRadius: 4, padding: '4px 8px',
            }}>
              <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {propCheck.invalid.length} connection{propCheck.invalid.length === 1 ? '' : 's'} not defined for{' '}
                <span style={{ fontFamily: 'var(--mono)' }}>{newLabel}</span> in the ontology:{' '}
                <span style={{ fontFamily: 'var(--mono)' }}>{propCheck.invalid.slice(0, 5).join(', ')}</span>
                {propCheck.invalid.length > 5 && ` +${propCheck.invalid.length - 5} more`}
                {' '}— they are kept as they are, but the export will not match the ontology.
              </span>
            </div>
          )}

          {literalHint && (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5, padding: '0 2px' }}>
              ℹ {literalHint}
            </div>
          )}

          {/* Free input (custom class, e.g. xsd:date) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input placeholder="Or free class label (e.g. xsd:date)" value={customLabel}
              onChange={e => { setCustomLabel(e.target.value); setMode(e.target.value ? 'custom' : 'list') }}
              onFocus={() => { if (customLabel) setMode('custom') }}
              style={{ flex: 1, fontSize: 10, padding: '3px 6px', fontFamily: 'var(--mono)' }} />
            <input placeholder="URI (optional)" value={customUri}
              onChange={e => { setCustomUri(e.target.value); if (customLabel) setMode('custom') }}
              style={{ width: 190, fontSize: 10, padding: '3px 6px', fontFamily: 'var(--mono)' }} />
          </div>

          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn-secondary" style={{ fontSize: 11 }} onClick={onCancel}>Cancel</button>
            <button className="btn-primary"
              style={{ fontSize: 11, opacity: canConfirm ? 1 : 0.4 }}
              onClick={handleConfirm}
              disabled={!canConfirm}>
              {newLabel ? `Change to "${newLabel}"` : 'Change class'}
            </button>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'right' }}>
            ℹ = Definition · Double-click = instant · Enter = confirm · Esc = cancel
          </div>
        </div>
      </div>
      <style>{`@keyframes modalIn { from { transform: scale(0.95) translateY(-8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }`}</style>
    </div>
  )
}

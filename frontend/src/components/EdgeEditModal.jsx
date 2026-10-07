import React, { useState } from 'react'
import { X, GitMerge, ChevronRight, Link2, Anchor, GitBranch, Globe2, AlertTriangle } from 'lucide-react'
import { isFoldedLiteralClass } from '../utils/graphml.js'

/**
 * Modal to edit an existing edge's metadata:
 * - Property label/URI
 * - Explorer display names (forward + inverse)
 * - Join-Key column
 * - Source/Target handles (connection points)
 */

const HANDLE_OPTIONS = [
  { value: 'l', label: '← Left' },
  { value: 'r', label: '→ Right' },
  { value: 't', label: '↑ Top' },
  { value: 'b', label: '↓ Bottom' },
]

function parseHandle(handle, type) {
  // handle format: "l-s", "r-t", "b-s", "t-t" etc.
  if (!handle) return type === 'source' ? 'r' : 'l'
  return handle.split('-')[0] || (type === 'source' ? 'r' : 'l')
}

export default function EdgeEditModal({ edge, sourceNode, targetNode, onConfirm, onCancel }) {
  const [label, setLabel] = useState(edge.data?.label || edge.label || '')
  const [propertyUri, setPropertyUri] = useState(edge.data?.propertyUri || '')
  const [joinColumnSource, setJoinColumnSource] = useState(edge.data?.joinColumnSource || '')
  const [joinColumnTarget, setJoinColumnTarget] = useState(edge.data?.joinColumnTarget || edge.data?.joinColumn || '')
  // Dot-One is created by drag & drop onto the edge, not edited here — the
  // existing values are only carried through unchanged on confirm.
  const dotOne = edge.data?.dotOne || ''
  const dotOneTarget = edge.data?.dotOneTarget || ''
  const [srcSide, setSrcSide] = useState(parseHandle(edge.sourceHandle, 'source'))
  const [tgtSide, setTgtSide] = useState(parseHandle(edge.targetHandle, 'target'))
  const [noInverse, setNoInverse] = useState(!!edge.data?.noInverse)
  const [inversePropertyUri, setInversePropertyUri] = useState(edge.data?.inversePropertyUri || '')
  const [explorerLabel, setExplorerLabel] = useState(edge.data?.explorerLabel || '')

  const srcCols = sourceNode?.data?.tableRows?.[0] ? Object.keys(sourceNode.data.tableRows[0]) : []
  const tgtCols = targetNode?.data?.tableRows?.[0] ? Object.keys(targetNode.data.tableRows[0]) : []

  // Free-text ranges (rdfs:Literal, xsd:*, geo:wktLiteral) are folded into the
  // domain node's attributes by the Graph Explorer export -- no node is emitted
  // for them, so there is nothing an opposite direction could point back from.
  // Both inverse controls would be silently ignored here, so say so instead.
  const targetIsLiteral = isFoldedLiteralClass(targetNode?.data?.uri)

  const handleConfirm = () => {
    onConfirm({
      label,
      propertyUri,
      joinColumnSource: joinColumnSource || null,
      joinColumnTarget: joinColumnTarget || null,
      dotOne: dotOne || null,
      dotOneTarget: dotOneTarget || null,
      sourceHandle: `${srcSide}-s`,
      targetHandle: `${tgtSide}-t`,
      noInverse,
      inversePropertyUri,
      explorerLabel,
    })
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border-bright)',
          borderRadius: 10, width: 480, maxHeight: '75vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          animation: 'modalIn 0.15s ease',
        }}
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter') handleConfirm() }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <GitMerge size={14} color="var(--orange)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Edit Edge</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{sourceNode?.data?.label}</span>
              <ChevronRight size={10} />
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--orange)' }}>{label || '?'}</span>
              <ChevronRight size={10} />
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)' }}>{targetNode?.data?.label}</span>
            </div>
          </div>
          <button className="btn-ghost" style={{ padding: '3px 6px' }} onClick={onCancel}><X size={13} /></button>
        </div>

        {/* Fields */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>

          {/* Property */}
          <div>
            <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 3 }}>
              Property Label
            </label>
            <input value={label} onChange={e => setLabel(e.target.value)}
              style={{ width: '100%', fontSize: 11, fontFamily: 'var(--mono)', padding: '5px 8px' }}
              placeholder="e.g. P2_has_type" />
          </div>
          <div>
            <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 3 }}>
              Property URI
            </label>
            <input value={propertyUri} onChange={e => setPropertyUri(e.target.value)}
              style={{ width: '100%', fontSize: 10, fontFamily: 'var(--mono)', padding: '5px 8px', color: 'var(--text-dim)' }}
              placeholder="http://..." />
          </div>

          {/* Graph Explorer-only display name override — replaces the CIDOC
              property name shown for THIS specific connection. Two edges with
              the same Explorer-Name merge into one group in the Explorer. */}
          <div>
            <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
              <Globe2 size={9} /> Explorer-Name (Property)
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input value={explorerLabel} onChange={e => setExplorerLabel(e.target.value)}
                style={{ flex: 1, fontSize: 11, padding: '5px 8px' }}
                placeholder="e.g. has material type" />
              {explorerLabel && (
                <button className="btn-ghost"
                  style={{ padding: '3px 6px', fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}
                  onClick={() => setExplorerLabel('')}
                  title="Remove Explorer name — the connection then uses its property name again">
                  <X size={10} /> Clear
                </button>
              )}
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'block', marginTop: 2 }}>
              Replaces the CIDOC property name in the Graph Explorer for this connection only. Two connections
              sharing the same Explorer name are merged into a single group in the Explorer. Has no effect on
              Dot-One relations (above/below/contemporary/corresponds).
            </span>
          </div>

          {/* Inverse Property override — only needed when the loaded ontology
              doesn't declare an owl:inverseOf for this property (or a custom/
              free-text property is used), and the auto-derived opposite
              direction should show something other than the same property in
              both directions. Leave empty to keep the automatic resolution. */}
          <div>
            <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
              <Globe2 size={9} /> Inverse Explorer-Name (Property)
            </label>
            <input value={inversePropertyUri} onChange={e => setInversePropertyUri(e.target.value)}
              disabled={targetIsLiteral}
              style={{
                width: '100%', fontSize: 10, fontFamily: 'var(--mono)', padding: '5px 8px', color: 'var(--text-dim)',
                opacity: targetIsLiteral ? 0.45 : 1,
                cursor: targetIsLiteral ? 'not-allowed' : 'text',
              }}
              placeholder={targetIsLiteral ? '(not available for free-text ranges)' : 'e.g. is incorporated in — empty = automatic from ontology'} />
            {targetIsLiteral ? (
              <span style={{ fontSize: 9, color: 'var(--orange)', display: 'flex', alignItems: 'flex-start', gap: 4, marginTop: 3, lineHeight: 1.4 }}>
                <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  The range <span style={{ fontFamily: 'var(--mono)' }}>{targetNode?.data?.label}</span> is a free-text
                  value: the Graph Explorer folds it into the attributes of{' '}
                  <span style={{ fontFamily: 'var(--mono)' }}>{sourceNode?.data?.label}</span> instead of creating a
                  node for it. With no node on the other end there is no opposite direction to name, so an inverse
                  entered here would have no effect on the export.
                  {inversePropertyUri && <> The stored value <span style={{ fontFamily: 'var(--mono)' }}>“{inversePropertyUri}”</span> is kept, but ignored.</>}
                </span>
              </span>
            ) : (
              <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'block', marginTop: 2 }}>
                Optional. Name shown for the opposite direction in the Graph Explorer — or the URI of an inverse
                property, whose label is then used. Only needed if the ontology declares no inverse, or if another
                name should be shown. Leave empty for automatic resolution (owl:inverseOf), or use “No automatic
                opposite direction” below. Avoid “/” and “#” in a name: only the text after them is shown.
              </span>
            )}
          </div>

          {/* Handles */}
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <Anchor size={9} /> Ausgang (Source)
              </label>
              <div style={{ display: 'flex', gap: 3 }}>
                {HANDLE_OPTIONS.map(h => (
                  <button key={h.value} onClick={() => setSrcSide(h.value)}
                    style={{
                      flex: 1, padding: '4px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                      border: '1px solid', textAlign: 'center',
                      background: srcSide === h.value ? 'var(--accent-glow)' : 'var(--bg)',
                      borderColor: srcSide === h.value ? 'var(--accent-dim)' : 'var(--border)',
                      color: srcSide === h.value ? 'var(--accent)' : 'var(--text-muted)',
                    }}>
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <Anchor size={9} /> Eingang (Target)
              </label>
              <div style={{ display: 'flex', gap: 3 }}>
                {HANDLE_OPTIONS.map(h => (
                  <button key={h.value} onClick={() => setTgtSide(h.value)}
                    style={{
                      flex: 1, padding: '4px 0', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                      border: '1px solid', textAlign: 'center',
                      background: tgtSide === h.value ? 'rgba(92,236,148,0.15)' : 'var(--bg)',
                      borderColor: tgtSide === h.value ? 'rgba(20,163,92,0.4)' : 'var(--border)',
                      color: tgtSide === h.value ? 'var(--green)' : 'var(--text-muted)',
                    }}>
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Join-Key Source (Domain) */}
          <div>
            <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
              <Link2 size={9} /> Join-Key Source (Domain)
            </label>
            <select value={joinColumnSource} onChange={e => setJoinColumnSource(e.target.value)}
              style={{ width: '100%', fontSize: 10, padding: '5px 8px', fontFamily: 'var(--mono)', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}>
              <option value="">(none – auto-detect)</option>
              {srcCols.map(c => <option key={`src_${c}`} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Join-Key Target (Range) */}
          <div>
            <label style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
              <Link2 size={9} /> Join-Key Target (Range)
            </label>
            <select value={joinColumnTarget} onChange={e => setJoinColumnTarget(e.target.value)}
              style={{ width: '100%', fontSize: 10, padding: '5px 8px', fontFamily: 'var(--mono)', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}>
              <option value="">(none – auto-detect)</option>
              {tgtCols.map(c => <option key={`tgt_${c}`} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Inverse suppression */}
          <div>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              cursor: targetIsLiteral ? 'not-allowed' : 'pointer',
              padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
              background: noInverse && !targetIsLiteral ? 'rgba(255,191,40,0.08)' : 'var(--bg)',
              opacity: targetIsLiteral ? 0.45 : 1,
            }}>
              <input type="checkbox" checked={noInverse}
                onChange={e => setNoInverse(e.target.checked)}
                disabled={targetIsLiteral}
                style={{ marginTop: 2 }} />
              <span>
                <span style={{ fontSize: 11, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <GitBranch size={10} /> No automatic opposite direction for this connection
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'block', marginTop: 2, lineHeight: 1.4 }}>
                  {targetIsLiteral
                    ? 'Not applicable: a free-text range never gets an opposite direction in the first place (see the note above).'
                    : `For every edge, the Graph Explorer normally also derives the view from the opposite side
                       (e.g. the inverse property or an inverted Dot-One value). Enable this if that derivation does
                       not apply — or is uncertain — for this specific connection; only the direction actually
                       modelled here will then appear.`}
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" style={{ fontSize: 11 }} onClick={onCancel}>Cancel</button>
          <button className="btn-primary" style={{ fontSize: 11 }} onClick={handleConfirm}>
            Apply
          </button>
        </div>
        <div style={{ padding: '0 16px 8px', fontSize: 9, color: 'var(--text-muted)', textAlign: 'right' }}>
          Double-click edge = open this dialog · Enter = confirm · Esc = cancel
        </div>
      </div>

      <style>{`@keyframes modalIn { from { transform: scale(0.95) translateY(-8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }`}</style>
    </div>
  )
}

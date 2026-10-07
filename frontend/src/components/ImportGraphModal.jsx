import React from 'react'
import { X, FileInput, AlertTriangle, ArrowRight } from 'lucide-react'

/**
 * Preview of an existing graph about to be imported. Shows what the canvas
 * will look like BEFORE anything is added, because an import appends a whole
 * set of nodes at once and is tedious to undo by hand.
 */
export default function ImportGraphModal({ payload, fileName, onConfirm, onCancel }) {
  const stats     = payload?.stats || {}
  const classes   = payload?.classes || []
  const relations = payload?.relations || []
  const literals  = payload?.literals || []
  const warnings  = payload?.warnings || []

  const shortName = (uri) => String(uri || '').split(/[#/]/).filter(Boolean).pop() || uri

  const stat = (value, label) => (
    <div style={{ flex: 1, textAlign: 'center', padding: '6px 4px', background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 15, fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-bright)', borderRadius: 10, width: 600, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.6)', animation: 'modalIn 0.15s ease' }}
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter') onConfirm() }}>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileInput size={14} color="var(--accent)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Import graph</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'var(--mono)' }}>
              {fileName} · {payload?.source === 'rdf' ? 'RDF' : 'Graph Explorer JSON'}
            </div>
          </div>
          <button className="btn-ghost" style={{ padding: '3px 6px' }} onClick={onCancel}><X size={13} /></button>
        </div>

        <div style={{ padding: '10px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
          {stat(stats.class_count ?? 0,    'Classes')}
          {stat(stats.relation_count ?? 0, 'Relations')}
          {stat(stats.literal_count ?? 0,  'Attributes')}
          {stat(stats.instance_count ?? 0, 'Instances')}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          <div style={{ padding: '6px 14px 3px', fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', background: 'var(--bg-card)' }}>
            One node per class — the instances stay in a table behind it
          </div>
          {classes.map(c => (
            <div key={c.class_uri} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', fontSize: 11 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.label}
              </span>
              {!String(c.class_uri).startsWith('http') && (
                <span style={{ fontSize: 9, color: '#a37200', background: 'rgba(255,191,40,0.1)', padding: '0 5px', borderRadius: 3, border: '1px solid rgba(163,114,0,0.25)' }}>
                  no URI
                </span>
              )}
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{c.instance_count}</span>
            </div>
          ))}

          {relations.length > 0 && (
            <>
              <div style={{ padding: '6px 14px 3px', fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', background: 'var(--bg-card)', borderTop: '1px solid var(--border)' }}>
                Connections ({relations.length})
              </div>
              {relations.slice(0, 12).map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 14px', fontSize: 10, fontFamily: 'var(--mono)' }}>
                  <span style={{ color: 'var(--accent)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(r.domain_class)}</span>
                  <ArrowRight size={9} color="var(--text-muted)" />
                  <span style={{ color: '#db2777', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                  <ArrowRight size={9} color="var(--text-muted)" />
                  <span style={{ color: 'var(--green)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(r.range_class)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>{r.count}</span>
                </div>
              ))}
              {relations.length > 12 && (
                <div style={{ padding: '2px 14px', fontSize: 9, color: 'var(--text-muted)' }}>+{relations.length - 12} more…</div>
              )}
            </>
          )}

          {literals.length > 0 && (
            <div style={{ padding: '6px 14px', fontSize: 9, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              {literals.length} attribute(s) become literal nodes on their class
              (e.g. <span style={{ fontFamily: 'var(--mono)' }}>{literals[0].label}</span>).
            </div>
          )}

          {stats.dot_one_count > 0 && (
            <div style={{ padding: '6px 14px', fontSize: 9, color: '#db2777', borderTop: '1px solid var(--border)' }}>
              {stats.dot_one_count} RDF-star annotation(s) become Dot-One qualifiers on{' '}
              {relations.filter(r => r.dot_one).length} connection(s) — e.g.{' '}
              <span style={{ fontFamily: 'var(--mono)' }}>
                {(relations.find(r => r.dot_one)?.dot_one?.label) || ''}
              </span>. Stratigraphic relations keep their above/below qualifier.
            </div>
          )}
        </div>

        {warnings.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 130, overflowY: 'auto' }}>
            {warnings.map((w, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 9, color: '#a37200', lineHeight: 1.5 }}>
                <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ flex: 1, fontSize: 9, color: 'var(--text-muted)' }}>
            Added to the current canvas — existing nodes stay untouched.
          </span>
          <button className="btn-secondary" style={{ fontSize: 11 }} onClick={onCancel}>Cancel</button>
          <button className="btn-primary" style={{ fontSize: 11 }} onClick={onConfirm}>
            Import {stats.class_count ?? 0} classes
          </button>
        </div>
      </div>
      <style>{`@keyframes modalIn { from { transform: scale(0.95) translateY(-8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }`}</style>
    </div>
  )
}

import React, { useState, useMemo } from 'react'
import { X, Plus, Trash2, Languages, AlertTriangle, Star } from 'lucide-react'
import {
  normalizeLanguages, isValidLangTag, normalizeLangTag,
  languagesLosingData,
} from '../utils/languages.js'

// A short list of the tags most likely wanted here, offered as one-click adds.
// Not a restriction — the input below accepts any well-formed BCP-47 tag.
const SUGGESTED = [
  { tag: 'de', name: 'Deutsch' },
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
  { tag: 'it', name: 'Italiano' },
  { tag: 'sl', name: 'Slovenščina' },
  { tag: 'hu', name: 'Magyar' },
  { tag: 'la', name: 'Latina' },
]

/**
 * Defines the project's label languages.
 *
 * The primary language matters more than it looks: the node's plain
 * `instanceLabel` / `explorerLabel` / `labelColumn` fields ARE the primary
 * language, so changing it moves text between storage slots (see
 * `remapNodeLanguages`). Removing a language deletes what it held — which is
 * why that is spelled out before saving, not after.
 */
export default function LanguageManagerModal({ languages, nodes = [], onSave, onClose }) {
  const current = normalizeLanguages(languages)
  const [primary, setPrimary]       = useState(current.primary)
  const [additional, setAdditional] = useState(current.additional)
  const [newTag, setNewTag]         = useState('')
  const [error, setError]           = useState('')

  const next = useMemo(
    () => normalizeLanguages({ primary, additional }),
    [primary, additional]
  )
  const all = [next.primary, ...next.additional]

  // What saving would throw away. Computed live so the warning appears the
  // moment a language is removed, not as a surprise after the click.
  const losing = useMemo(
    () => languagesLosingData(nodes, current, next),
    [nodes, current, next]
  )

  const primaryChanged = next.primary !== current.primary

  const handleAdd = (raw) => {
    const tag = normalizeLangTag(raw)
    if (!tag) { setError('Enter a language tag'); return }
    if (!isValidLangTag(tag)) { setError(`"${tag}" is not a valid language tag (de, en, de-AT, …)`); return }
    if (all.includes(tag)) { setError(`"${tag}" is already in the list`); return }
    setAdditional(a => [...a, tag])
    setNewTag(''); setError('')
  }

  const handleRemove = (tag) => {
    setAdditional(a => a.filter(t => t !== tag))
    setError('')
  }

  // Promoting an additional language swaps it with the current primary, so
  // nothing silently drops out of the list.
  const handleMakePrimary = (tag) => {
    if (tag === primary) return
    setAdditional(a => [...a.filter(t => t !== tag), primary].filter(Boolean))
    setPrimary(tag)
    setError('')
  }

  const inp = {
    fontSize: 11, padding: '4px 8px',
    background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 4, color: 'var(--text)', fontFamily: 'var(--mono)',
    outline: 'none',
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, width: 560, maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Languages size={15} color="var(--accent)" />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Label Languages</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}><X size={16} /></button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Every node offers one label slot per language here. The <b style={{ color: 'var(--text)' }}>primary</b> language
          is the one written into <code style={{ fontFamily: 'var(--mono)' }}>rdfs:label</code> without a suffix in the TSV,
          and the one the Graph Explorer falls back to. With a single language the
          canvas looks exactly as it did — the language chips on the nodes only
          appear from the second one on.
        </div>

        {/* Current languages */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {all.map(tag => {
            const isPrimary = tag === next.primary
            return (
              <div key={tag} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', borderRadius: 6,
                background: isPrimary ? 'rgba(219,39,119,0.07)' : 'var(--bg)',
                border: `1px solid ${isPrimary ? 'rgba(219,39,119,0.3)' : 'var(--border)'}`,
              }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                  color: isPrimary ? '#db2777' : 'var(--text)', width: 54,
                }}>
                  {tag}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                  {SUGGESTED.find(s => s.tag === tag)?.name || ''}
                </span>
                {isPrimary ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#db2777', fontWeight: 600 }}>
                    <Star size={10} /> primary
                  </span>
                ) : (
                  <>
                    <button onClick={() => handleMakePrimary(tag)}
                      title="Make this the primary language — existing labels move with it"
                      style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, padding: '2px 7px' }}>
                      make primary
                    </button>
                    <button onClick={() => handleRemove(tag)}
                      title="Remove this language"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', opacity: 0.6 }}
                      onMouseEnter={e => e.currentTarget.style.opacity = 1}
                      onMouseLeave={e => e.currentTarget.style.opacity = 0.6}>
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* Quick add */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Add a language:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {SUGGESTED.filter(sg => !all.includes(sg.tag)).map(sg => (
              <button key={sg.tag} onClick={() => handleAdd(sg.tag)} title={sg.name}
                style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--accent)', fontFamily: 'var(--mono)' }}>
                + {sg.tag}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={newTag} onChange={e => { setNewTag(e.target.value); setError('') }}
              placeholder="de-AT"
              style={{ ...inp, width: 120 }}
              onKeyDown={e => e.key === 'Enter' && handleAdd(newTag)} />
            <button onClick={() => handleAdd(newTag)} className="btn-secondary"
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' }}>
              <Plus size={11} /> Add
            </button>
            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>any BCP-47 tag</span>
          </div>
          {error && <div style={{ fontSize: 10, color: '#f87171', marginTop: 6 }}>{error}</div>}
        </div>

        {/* Consequences of saving */}
        {(losing.length > 0 || primaryChanged) && (
          <div style={{ background: 'rgba(255,191,40,0.08)', border: '1px solid rgba(163,114,0,0.25)', borderRadius: 6, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#a37200', fontWeight: 600, marginBottom: 6 }}>
              <AlertTriangle size={12} /> What saving will do
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {primaryChanged && (
                <li>
                  Primary language <code style={{ fontFamily: 'var(--mono)' }}>{current.primary}</code> →{' '}
                  <code style={{ fontFamily: 'var(--mono)' }}>{next.primary}</code>: existing labels are re-sorted
                  accordingly, so every text keeps the language it was written in.
                </li>
              )}
              {losing.map(({ lang, nodeCount }) => (
                <li key={lang}>
                  <b style={{ color: '#a37200' }}>
                    "{lang}" is removed — its labels on {nodeCount} node{nodeCount === 1 ? '' : 's'} are deleted.
                  </b>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-secondary" onClick={onClose} style={{ fontSize: 11 }}>Cancel</button>
          <button className="btn-primary" onClick={() => onSave(next)} style={{ fontSize: 11 }}>Save</button>
        </div>
      </div>
    </div>
  )
}

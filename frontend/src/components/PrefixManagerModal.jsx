import React, { useState, useMemo } from 'react'
import { X, Plus, Trash2, Tag, AlertTriangle } from 'lucide-react'

export default function PrefixManagerModal({ prefixMap, idPrefix, onSave, onClose, ontologyPrefixes = [], tableData = [], nodes = [] }) {
  const [rows, setRows]   = useState(
    Object.entries(prefixMap).map(([p, ns]) => ({ prefix: p, ns }))
  )
  const [localIdPrefix, setLocalIdPrefix] = useState(idPrefix)
  const [newPrefix, setNewPrefix]         = useState('')
  const [newNs,     setNewNs]             = useState('')
  const [error,     setError]             = useState('')

  // ── Detect prefixes used in table data / node labels ──────────────────
  const detectedTablePrefixes = useMemo(() => {
    const found = new Set()
    const prefixPattern = /^([a-zA-Z][a-zA-Z0-9_]*):./

    // Scan all table rows from all nodes that have table data
    for (const node of (nodes || [])) {
      const d = node.data || {}
      // Check instanceLabel
      if (d.instanceLabel) {
        const m = String(d.instanceLabel).match(prefixPattern)
        if (m) found.add(m[1])
      }
      // Check mapped table rows
      if (d.tableRows && d.mappedColumn) {
        for (const row of d.tableRows) {
          for (const val of Object.values(row)) {
            if (val == null) continue
            const m = String(val).match(prefixPattern)
            if (m) found.add(m[1])
          }
        }
      }
    }

    // Also scan global table data
    for (const row of (tableData || [])) {
      for (const val of Object.values(row)) {
        if (val == null) continue
        const m = String(val).match(prefixPattern)
        if (m) found.add(m[1])
      }
    }

    // Filter out prefixes already in the map
    const knownPrefixes = new Set(Object.keys(prefixMap))
    return [...found]
      .filter(p => !knownPrefixes.has(p) && !['http', 'https', 'ftp', 'file', 'mailto'].includes(p))
      .sort()
  }, [nodes, tableData, prefixMap])

  const handleChange = (i, field, val) => {
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }
  const handleDelete = (i) => setRows(rs => rs.filter((_, idx) => idx !== i))

  const handleAdd = () => {
    const p  = newPrefix.trim().replace(/:$/, '')
    const ns = newNs.trim()
    if (!p || !ns) { setError('Prefix and namespace are required'); return }
    if (rows.some(r => r.prefix === p)) { setError(`Prefix "${p}" already exists`); return }
    setRows(rs => [...rs, { prefix: p, ns }])
    setNewPrefix(''); setNewNs(''); setError('')
  }

  const handleAddFromOntology = (op) => {
    if (rows.some(r => r.prefix === op.prefix || r.ns === op.namespace)) return
    setRows(rs => [...rs, { prefix: op.prefix, ns: op.namespace }])
  }

  const handleSave = () => {
    const map = {}
    for (const { prefix, ns } of rows) {
      if (prefix && ns) map[prefix] = ns
    }
    onSave(map, localIdPrefix.trim())
    onClose()
  }

  const inp = {
    fontSize: 11, padding: '4px 8px',
    background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 4, color: 'var(--text)', fontFamily: 'var(--mono)',
    outline: 'none',
  }

  return (
    <div
      style={{ position:'fixed', inset:0, zIndex:9000, background:'rgba(0,0,0,0.65)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:10, padding:24, width:660, maxWidth:'95vw', maxHeight:'85vh', display:'flex', flexDirection:'column', gap:16, boxShadow:'0 8px 40px rgba(0,0,0,0.5)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <Tag size={15} color="var(--accent)" />
            <span style={{ fontSize:14, fontWeight:600, color:'var(--text)' }}>Namespace Prefix Manager</span>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', display:'flex' }}><X size={16} /></button>
        </div>

        {/* Data-ID prefix */}
        <div style={{ background:'var(--bg)', borderRadius:6, padding:'10px 14px', border:'1px solid var(--border)' }}>
          <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:6 }}>
            <b style={{ color:'var(--text)' }}>Data ID Prefix</b> — is prepended to all value IDs (e.g. <code style={{ fontFamily:'var(--mono)' }}>your_prefix:[value]</code>)
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <input value={localIdPrefix} onChange={e => setLocalIdPrefix(e.target.value)} style={{ ...inp, width:110 }} placeholder="your_prefix" />
            <span style={{ fontSize:12, color:'var(--text-muted)', fontFamily:'var(--mono)' }}>:</span>
          </div>
        </div>

        {/* Ontology-detected prefixes */}
        {ontologyPrefixes.length > 0 && (
          <div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:6 }}>Prefixes detected from loaded ontology (click to add):</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {ontologyPrefixes.map(op => {
                const already = rows.some(r => r.prefix === op.prefix || r.ns === op.namespace)
                return (
                  <button key={op.prefix} onClick={() => handleAddFromOntology(op)} disabled={already}
                    title={op.namespace}
                    style={{ fontSize:10, padding:'3px 8px', borderRadius:4, cursor:already?'default':'pointer', border:'1px solid var(--border)', background:already?'var(--bg)':'var(--bg-card)', color:already?'var(--text-muted)':'var(--accent)', fontFamily:'var(--mono)', opacity:already?0.5:1 }}
                  >
                    {already ? '✓ ' : '+ '}{op.prefix}:
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Unresolved table prefixes warning */}
        {detectedTablePrefixes.length > 0 && (
          <div style={{ background:'rgba(255,191,40,0.08)', border:'1px solid rgba(163,114,0,0.25)', borderRadius:6, padding:'10px 14px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:'#a37200', fontWeight:600, marginBottom:6 }}>
              <AlertTriangle size={12} />
              Prefixes found in tables/nodes without namespace definition:
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {detectedTablePrefixes.map(p => {
                const nowDefined = rows.some(r => r.prefix === p)
                return (
                  <button key={p}
                    onClick={() => {
                      if (!nowDefined) {
                        setNewPrefix(p)
                        setNewNs('')
                      }
                    }}
                    style={{
                      fontSize:10, padding:'3px 8px', borderRadius:4, fontFamily:'var(--mono)',
                      border: nowDefined ? '1px solid rgba(20,163,92,0.3)' : '1px solid rgba(163,114,0,0.4)',
                      background: nowDefined ? 'rgba(92,236,148,0.08)' : 'rgba(255,191,40,0.08)',
                      color: nowDefined ? 'var(--green)' : '#a37200',
                      cursor: nowDefined ? 'default' : 'pointer',
                    }}
                    title={nowDefined ? 'Already defined' : `Click to add "${p}" "`}
                  >
                    {nowDefined ? '✓ ' : '⚠ '}{p}:
                  </button>
                )
              })}
            </div>
            <div style={{ fontSize:9, color:'var(--text-muted)', marginTop:6 }}>
              Click a prefix to prefill it below, then add the matching namespace URI.
              Unresolved prefixes will not be correctly expanded on export.
            </div>
          </div>
        )}

        {/* Prefix table */}
        <div style={{ overflowY:'auto', flex:1 }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--border)' }}>
                <th style={{ textAlign:'left', padding:'4px 8px', color:'var(--text-muted)', fontWeight:500, width:120 }}>Prefix</th>
                <th style={{ textAlign:'left', padding:'4px 8px', color:'var(--text-muted)', fontWeight:500 }}>Namespace URI</th>
                <th style={{ width:32 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding:'4px 8px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:2 }}>
                      <input value={row.prefix} onChange={e => handleChange(i,'prefix',e.target.value)} style={{ ...inp, width:85 }} />
                      <span style={{ color:'var(--text-muted)', fontFamily:'var(--mono)', fontSize:12 }}>:</span>
                    </div>
                  </td>
                  <td style={{ padding:'4px 8px' }}>
                    <input value={row.ns} onChange={e => handleChange(i,'ns',e.target.value)} style={{ ...inp, width:'100%' }} />
                  </td>
                  <td style={{ padding:'4px 4px', textAlign:'center' }}>
                    <button onClick={() => handleDelete(i)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', display:'flex', opacity:0.6 }}
                      onMouseEnter={e => e.currentTarget.style.opacity=1} onMouseLeave={e => e.currentTarget.style.opacity=0.6}><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add new */}
        <div style={{ borderTop:'1px solid var(--border)', paddingTop:12 }}>
          {error && <div style={{ fontSize:10, color:'#f87171', marginBottom:6 }}>{error}</div>}
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            <input value={newPrefix} onChange={e => setNewPrefix(e.target.value)} placeholder="prefix" style={{ ...inp, width:90 }} onKeyDown={e => e.key==='Enter' && handleAdd()} />
            <span style={{ color:'var(--text-muted)', fontFamily:'var(--mono)', fontSize:12 }}>:</span>
            <input value={newNs} onChange={e => setNewNs(e.target.value)} placeholder="https://example.org/ontology/" style={{ ...inp, flex:1 }} onKeyDown={e => e.key==='Enter' && handleAdd()} />
            <button onClick={handleAdd} className="btn-secondary" style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, padding:'4px 10px', whiteSpace:'nowrap' }}>
              <Plus size={11} /> Add
            </button>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
          <button className="btn-secondary" onClick={onClose} style={{ fontSize:11 }}>Cancel</button>
          <button className="btn-primary"   onClick={handleSave} style={{ fontSize:11 }}>Save</button>
        </div>
      </div>
    </div>
  )
}

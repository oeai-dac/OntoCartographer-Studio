import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Upload, X, Search, ChevronDown, ChevronRight, Database, AlertCircle, GitBranch, ArrowUp, ArrowDown, Info } from 'lucide-react'
import { api } from '../utils/api.js'

// ── Ancestry breadcrumb strip ─────────────────────────────────────────────────
function AncestryStrip({ ancestors, namespaceMap }) {
  if (!ancestors || ancestors.length === 0) return null
  // Show max 3 nearest ancestors
  const shown = ancestors.slice(0, 3)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap',
      marginTop: 4, padding: '3px 0',
    }}>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', marginRight: 2 }}>↑</span>
      {shown.map((a, i) => (
        <React.Fragment key={a.uri}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9,
            color: 'var(--text-muted)',
            background: 'var(--bg)', padding: '1px 5px',
            borderRadius: 3, border: '1px solid var(--border)',
          }}>
            {a.label}
          </span>
          {i < shown.length - 1 && <ChevronRight size={8} color="var(--border-bright)" />}
        </React.Fragment>
      ))}
      {ancestors.length > 3 && (
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>+{ancestors.length - 3} more</span>
      )}
    </div>
  )
}

// ── Searchable Dropdown (now with inheritance badges) ─────────────────────────
function SearchableDropdown({ placeholder, items, value, onChange, disabled, loading, showInheritance }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [infoUri, setInfoUri] = useState(null)
  const ref = useRef(null)

  const filtered = items.filter(item =>
    item.label.toLowerCase().includes(search.toLowerCase()) ||
    (item.rdfs_label && item.rdfs_label.toLowerCase().includes(search.toLowerCase()))
  )

  const selected = items.find(i => i.uri === value)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Group: direct first, then inherited, then widened
  const direct = showInheritance ? filtered.filter(i => !i.inherited_from?.length && !i.widened_from?.length) : filtered
  const inherited = showInheritance ? filtered.filter(i => i.inherited_from?.length > 0) : []
  const widened = showInheritance ? filtered.filter(i => i.widened_from?.length > 0) : []

  const renderItem = (item) => {
    const isInherited = showInheritance && item.inherited_from?.length > 0
    const isWidened = showInheritance && item.widened_from?.length > 0
    return (
      <div key={item.uri}>
        <button
          className="btn-ghost"
          style={{
            width: '100%', textAlign: 'left', padding: '6px 12px',
            borderRadius: 0, display: 'flex', flexDirection: 'column', gap: 2,
            background: item.uri === value ? 'var(--accent-glow)' : undefined,
            borderLeft: isWidened ? '2px solid #a37200' : isInherited ? '2px solid var(--border-bright)' : '2px solid transparent',
          }}
          onClick={() => { onChange(item); setSearch(''); setOpen(false); setInfoUri(null) }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 11,
              color: item.uri === value ? 'var(--accent)' : (isWidened ? '#a37200' : isInherited ? 'var(--text-dim)' : 'var(--text)'),
            }}>
              {item.label}
            </span>
            {(item.rdfs_comment || item.rdfs_label) && (
              <span
                onClick={(e) => { e.stopPropagation(); setInfoUri(infoUri === item.uri ? null : item.uri) }}
                style={{
                  background: infoUri === item.uri ? 'var(--accent-glow)' : 'transparent',
                  border: '1px solid', borderColor: infoUri === item.uri ? 'var(--accent-dim)' : 'var(--border)',
                  borderRadius: 3, padding: '0 3px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
                  color: infoUri === item.uri ? 'var(--accent)' : 'var(--text-muted)',
                }}
                title="Show definition"
              >
                <Info size={9} />
              </span>
            )}
            {isInherited && (
              <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', padding: '0 4px', borderRadius: 3, border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                ↑ {item.inherited_from.map(u => u.split(/[#/]/).pop()).join(', ')}
              </span>
            )}
            {isWidened && (
              <span style={{ fontSize: 9, color: '#a37200', background: 'rgba(255,191,40,0.1)', padding: '0 4px', borderRadius: 3, border: '1px solid rgba(163,114,0,0.25)', whiteSpace: 'nowrap' }}>
                ↓ {item.widened_from.map(u => u.split(/[#/]/).pop()).join(', ')}
              </span>
            )}
          </div>
          {item.rdfs_label && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{item.rdfs_label}</span>
          )}
        </button>
        {infoUri === item.uri && (item.rdfs_comment || item.rdfs_label) && (
          <div style={{
            padding: '6px 12px 6px 16px', fontSize: 10, color: 'var(--text-dim)',
            background: 'rgba(25,190,207,0.06)', borderLeft: '2px solid var(--accent)',
            lineHeight: 1.5, maxHeight: 100, overflowY: 'auto',
          }}>
            {item.rdfs_comment || item.rdfs_label}
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="btn-secondary"
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 6, padding: '7px 10px',
          opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--mono)', fontSize: 11,
        }}
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
      >
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: selected ? 'var(--accent)' : 'var(--text-muted)',
        }}>
          {loading ? '⏳ Loading…' : selected ? selected.label : placeholder}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {items.length > 0 && (
            <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', padding: '1px 5px', borderRadius: 10 }}>
              {items.length}
            </span>
          )}
          <ChevronDown size={12} color="var(--text-muted)" />
        </div>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          background: 'var(--bg-card)', border: '1px solid var(--border-bright)',
          borderRadius: 'var(--radius)', marginTop: 3,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          maxHeight: 300, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input autoFocus placeholder="Search…" value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ paddingLeft: 26 }} />
            </div>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '10px 12px', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
                No results
              </div>
            ) : showInheritance ? (
              <>
                {direct.length > 0 && (
                  <>
                    <div style={{ padding: '4px 12px', fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      Direkt
                    </div>
                    {direct.map(renderItem)}
                  </>
                )}
                {inherited.length > 0 && (
                  <>
                    <div style={{ padding: '4px 12px', fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', letterSpacing: '0.08em', textTransform: 'uppercase', borderTop: '1px solid var(--border)' }}>
                      Inherited from parent classes
                    </div>
                    {inherited.map(renderItem)}
                  </>
                )}
                {widened.length > 0 && (
                  <>
                    <div style={{ padding: '4px 12px', fontSize: 9, color: '#a37200', background: 'rgba(255,191,40,0.05)', letterSpacing: '0.08em', textTransform: 'uppercase', borderTop: '1px solid rgba(255,191,40,0.15)' }}>
                      Widening: from subclasses ({widened.length})
                    </div>
                    {widened.map(renderItem)}
                  </>
                )}
              </>
            ) : (
              filtered.map(renderItem)
            )}
          </div>

          <div style={{ padding: '4px 12px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 9, display: 'flex', gap: 8 }}>
            <span>{filtered.length} entries</span>
            {showInheritance && inherited.length > 0 && (
              <span style={{ color: 'var(--border-bright)' }}>{inherited.length} inherited</span>
            )}
            {showInheritance && widened.length > 0 && (
              <span style={{ color: '#a37200' }}>{widened.length} widened</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Hierarchy mini-tree (collapsible) ─────────────────────────────────────────
function HierarchyLine({ label, uri, depth = 0, isCurrent = false }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      paddingLeft: depth * 12,
      padding: `2px 8px 2px ${8 + depth * 12}px`,
      background: isCurrent ? 'var(--accent-glow)' : 'transparent',
      borderRadius: 3,
    }}>
      {depth > 0 && <span style={{ color: 'var(--border-bright)', fontSize: 9 }}>└</span>}
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10,
        color: isCurrent ? 'var(--accent)' : 'var(--text-dim)',
        fontWeight: isCurrent ? 600 : 400,
      }}>
        {label}
      </span>
    </div>
  )
}

// ── Main OntologyPanel ────────────────────────────────────────────────────────
export default function OntologyPanel({ onDragStart, widening, wideningParent = true, toast }) {
  const [ontologies, setOntologies] = useState([])
  const [uploading, setUploading] = useState(false)
  const [backendOk, setBackendOk] = useState(null)
  const [indexStats, setIndexStats] = useState(null)

  // Triple selector
  const [subject, setSubject] = useState(null)
  const [predicate, setPredicate] = useState(null)
  const [object, setObject] = useState(null)

  const [subjects, setSubjects] = useState([])
  const [predicates, setPredicates] = useState([])
  const [objects, setObjects] = useState([])

  const [loadingSubjects, setLoadingSubjects] = useState(false)
  const [loadingPredicates, setLoadingPredicates] = useState(false)
  const [loadingObjects, setLoadingObjects] = useState(false)

  // Hierarchy context for selected subject
  const [ancestors, setAncestors] = useState([])
  const [descendants, setDescendants] = useState([])
  const [showHierarchy, setShowHierarchy] = useState(false)

  // Backend health
  useEffect(() => {
    api.health()
      .then(d => { setBackendOk(true); setIndexStats(d) })
      .catch(() => setBackendOk(false))
  }, [])

  // Ontology list on mount
  useEffect(() => {
    api.listOntologies().then(d => setOntologies(d.ontologies)).catch(() => {})
  }, [])

  // Load subjects when ontologies change
  useEffect(() => {
    if (ontologies.length === 0) { setSubjects([]); return }
    setLoadingSubjects(true)
    api.getClasses()
      .then(d => setSubjects(d.classes))
      .finally(() => setLoadingSubjects(false))
  }, [ontologies])

  // Load predicates + hierarchy when subject changes
  useEffect(() => {
    if (!subject) {
      setPredicates([]); setPredicate(null)
      setObjects([]); setObject(null)
      setAncestors([]); setDescendants([])
      return
    }
    setPredicate(null); setObject(null); setObjects([])
    setLoadingPredicates(true)

    // Parallel: properties + superclasses + subclasses
    Promise.all([
      api.getProperties(subject.uri, '', widening, wideningParent),
      api.getSuperclasses(subject.uri),
      api.getSubclasses(subject.uri),
    ]).then(([propsData, superData, subData]) => {
      setPredicates(propsData.properties)
      setAncestors(superData.superclasses)
      setDescendants(subData.subclasses)
    }).finally(() => setLoadingPredicates(false))
  }, [subject, widening, wideningParent])

  // Load objects when predicate changes
  useEffect(() => {
    if (!subject || !predicate) { setObjects([]); setObject(null); return }
    setLoadingObjects(true); setObject(null)
    api.getRange(subject.uri, predicate.uri)
      .then(d => setObjects(d.ranges))
      .finally(() => setLoadingObjects(false))
  }, [predicate])

  // File upload
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setUploading(true)
    try {
      const result = await api.uploadOntologies(files)
      setOntologies(result.ontologies)
      setIndexStats({
        classes_indexed: result.classes_indexed,
        properties_indexed: result.properties_indexed,
      })
      // A file that cannot be parsed is skipped by the backend; say so, or it
      // simply never shows up in the list and nobody knows why.
      const failed = (result.errors || []).map(er => er.file)
      if (failed.length > 0) {
        toast?.error(`Could not read ${failed.length === 1 ? 'ontology' : 'ontologies'}: ${failed.join(', ')} — is it valid RDF (Turtle, RDF/XML, N-Triples, N3)?`)
      }
      if (result.loaded?.length > 0) {
        toast?.success(`${result.loaded.length} ${result.loaded.length === 1 ? 'ontology' : 'ontologies'} loaded · ${result.classes_indexed} classes, ${result.properties_indexed} properties`)
      }
      // Fetch detected namespaces and broadcast to App
      try {
        const nsResult = await api.getNamespaces()
        const prefixes = Object.entries(nsResult.namespaces || {})
          .filter(([p, ns]) => p && ns && !['rdf','rdfs','owl','xsd','xml'].includes(p))
          .map(([prefix, namespace]) => ({ prefix, namespace }))
        window.dispatchEvent(new CustomEvent('ontology:namespaces', { detail: prefixes }))
      } catch (_) {}
    } catch (err) {
      console.error(err)
      toast?.error('Loading ontologies failed: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDeleteOntology = async (name) => {
    await api.deleteOntology(name).catch(() => {})
    const updated = await api.listOntologies()
    setOntologies(updated.ontologies)
    setSubject(null)
  }

  // Listen for node-focus events from graph (double-click on node)
  useEffect(() => {
    const handler = (e) => {
      const data = e.detail
      if (!data?.uri) return
      // Find matching subject and preselect
      const match = subjects.find(s => s.uri === data.uri)
      if (match) setSubject(match)
    }
    window.addEventListener('ontology:focusNode', handler)
    return () => window.removeEventListener('ontology:focusNode', handler)
  }, [subjects])

  const handleDragStart = (e, item, type) => {
    const payload = type === 'object' ? { ...item, type, predicate } : { ...item, type }
    e.dataTransfer.setData('application/ontology', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart?.(payload)
  }

  const directProps = predicates.filter(p => !p.inherited_from?.length && !p.widened_from?.length)
  const inheritedProps = predicates.filter(p => p.inherited_from?.length > 0)
  const widenedProps = predicates.filter(p => p.widened_from?.length > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Backend offline warning */}
      {backendOk === false && (
        <div style={{
          background: 'rgba(201,64,82,0.08)', borderBottom: '1px solid rgba(201,64,82,0.2)',
          color: 'var(--red)', padding: '7px 12px', fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <AlertCircle size={12} />
          Backend offline — please start the FastAPI server
        </div>
      )}

      {/* ── Ontologies ── */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Ontologies
          </span>
          <label style={{ cursor: 'pointer' }}>
            <input type="file" accept=".ttl,.rdf,.owl,.xml,.nt,.n3" multiple style={{ display: 'none' }} onChange={handleFileUpload} />
            <div className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 10px' }}>
              <Upload size={11} />
              {uploading ? 'Loading…' : 'Load'}
            </div>
          </label>
        </div>

        {ontologies.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>No ontology loaded</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {ontologies.map(name => (
              <div key={name} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'var(--bg-card)', borderRadius: 'var(--radius)',
                padding: '4px 8px', border: '1px solid var(--border)',
              }}>
                <Database size={10} color="var(--accent)" />
                <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </span>
                <button className="btn-danger" style={{ padding: '1px 3px' }} onClick={() => handleDeleteOntology(name)}>
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Index stats */}
        {indexStats && (indexStats.classes_indexed > 0 || indexStats.properties_indexed > 0) && (
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <span className="tag">{indexStats.classes_indexed} Classes</span>
            <span className="tag">{indexStats.properties_indexed} Properties</span>
          </div>
        )}
      </div>

      {/* ── Triple Explorer ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          Triple Explorer
        </span>

        {/* ① Subject */}
        <div>
          <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            ① Subject / Domain
          </label>
          <SearchableDropdown
            placeholder="Select class…"
            items={subjects}
            value={subject?.uri}
            onChange={setSubject}
            disabled={ontologies.length === 0}
            loading={loadingSubjects}
          />

          {/* Hierarchy context */}
          {subject && (
            <div style={{
              marginTop: 6, padding: '6px 8px',
              background: 'var(--accent-glow)', border: '1px solid var(--accent-dim)',
              borderRadius: 'var(--radius)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                <div
                  className="draggable-item"
                  draggable
                  onDragStart={e => handleDragStart(e, subject, 'subject')}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 5 }}
                >
                  <span style={{ opacity: 0.5 }}>⠿</span>
                  {subject.label}
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>drag</span>
                </div>
                {(ancestors.length > 0 || descendants.length > 0) && (
                  <button
                    className="btn-ghost"
                    style={{ padding: '1px 5px', fontSize: 9 }}
                    onClick={() => setShowHierarchy(h => !h)}
                    title="Show hierarchy"
                  >
                    <GitBranch size={10} />
                  </button>
                )}
              </div>

              {/* Ancestor breadcrumb (always show 1 level) */}
              {ancestors.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                  <ArrowUp size={9} color="var(--text-muted)" />
                  {ancestors.slice(0, 3).map((a, i) => (
                    <React.Fragment key={a.uri}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border)' }}>
                        {a.label}
                      </span>
                      {i < Math.min(ancestors.length, 3) - 1 && <ChevronRight size={8} color="var(--border-bright)" />}
                    </React.Fragment>
                  ))}
                  {ancestors.length > 3 && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>+{ancestors.length - 3}</span>}
                </div>
              )}

              {/* Expanded hierarchy */}
              {showHierarchy && descendants.length > 0 && (
                <div style={{ marginTop: 5, paddingTop: 5, borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 3 }}>
                    <ArrowDown size={9} color="var(--green)" />
                    <span style={{ fontSize: 9, color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {descendants.length} Subclasses
                    </span>
                  </div>
                  {descendants.slice(0, 6).map(d => (
                    <div key={d.uri} style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-muted)', padding: '1px 0 1px 10px' }}>
                      └ {d.label}
                    </div>
                  ))}
                  {descendants.length > 6 && (
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', paddingLeft: 10 }}>+{descendants.length - 6} more…</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ② Predicate */}
        <div>
          <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            ② Property / Predicate
            {predicates.length > 0 && (
              <span style={{ marginLeft: 6, color: 'var(--border-bright)', fontWeight: 400 }}>
                ({directProps.length} direct · {inheritedProps.length} inherited{widenedProps.length > 0 ? ` · ${widenedProps.length} widened` : ''})
              </span>
            )}
          </label>
          <SearchableDropdown
            placeholder="Select property…"
            items={predicates}
            value={predicate?.uri}
            onChange={setPredicate}
            disabled={!subject}
            loading={loadingPredicates}
            showInheritance={true}
          />

          {predicate && (
            <div style={{
              marginTop: 5, padding: '5px 8px',
              background: predicate.widened_from?.length > 0 ? 'rgba(255,191,40,0.06)' : 'rgba(255,191,40,0.06)',
              border: `1px solid ${predicate.widened_from?.length > 0 ? 'rgba(255,191,40,0.2)' : 'rgba(255,191,40,0.2)'}`,
              borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', fontSize: 10,
              color: predicate.widened_from?.length > 0 ? '#a37200' : 'var(--purple)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span>→</span>
                <span>{predicate.label}</span>
                {predicate.inherited_from?.length > 0 && (
                  <span style={{
                    fontSize: 9, color: 'var(--text-muted)',
                    background: 'var(--bg)', padding: '0 5px',
                    borderRadius: 3, border: '1px solid var(--border)',
                  }}>
                    ↑ {predicate.inherited_from.map(u => u.split(/[#/]/).pop()).join(', ')}
                  </span>
                )}
                {predicate.widened_from?.length > 0 && (
                  <span style={{
                    fontSize: 9, color: '#a37200',
                    background: 'rgba(255,191,40,0.1)', padding: '0 5px',
                    borderRadius: 3, border: '1px solid rgba(163,114,0,0.25)',
                  }}>
                    ↓ {predicate.widened_from.map(u => u.split(/[#/]/).pop()).join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ③ Object */}
        <div>
          <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            ③ Object / Range
            {objects.length > 0 && (
              <span style={{ marginLeft: 6, color: 'var(--border-bright)', fontWeight: 400 }}>
                ({objects.filter(o => o.is_direct_range).length} direct · {objects.filter(o => !o.is_direct_range).length} subclasses)
              </span>
            )}
          </label>
          <SearchableDropdown
            placeholder="Select range…"
            items={objects}
            value={object?.uri}
            onChange={setObject}
            disabled={!predicate}
            loading={loadingObjects}
          />

          {object && predicate && (
            <div
              className="draggable-item"
              draggable
              onDragStart={e => handleDragStart(e, object, 'object')}
              style={{
                marginTop: 5, padding: '5px 8px',
                background: 'rgba(92,236,148,0.08)', border: '1px solid rgba(20,163,92,0.25)',
                borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <span style={{ opacity: 0.5 }}>⠿</span>
              <span>{object.label}</span>
              {!object.is_direct_range && (
                <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', padding: '0 4px', borderRadius: 3, border: '1px solid var(--border)' }}>
                  subclass
                </span>
              )}
              <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>drag</span>
            </div>
          )}
        </div>

        {/* Triple preview */}
        {subject && predicate && object && (
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: 10, fontSize: 10,
          }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Triple Preview
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{subject.label}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 10 }}>
                <span style={{ color: 'var(--border-bright)' }}>→</span>
                <span style={{ color: predicate.widened_from?.length > 0 ? '#a37200' : 'var(--purple)', fontFamily: 'var(--mono)' }}>{predicate.label}</span>
                {predicate.inherited_from?.length > 0 && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                    (inherited)
                  </span>
                )}
                {predicate.widened_from?.length > 0 && (
                  <span style={{ fontSize: 9, color: '#a37200' }}>
                    (widened)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 20 }}>
                <span style={{ color: 'var(--border-bright)' }}>→</span>
                <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>{object.label}</span>
                {!object.is_direct_range && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>(subclass)</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

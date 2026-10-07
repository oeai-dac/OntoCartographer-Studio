import React, { useState, useEffect } from 'react'
import { Handle, Position } from 'reactflow'
import { Tag, Link2, X, Globe2, Replace, ChevronDown, ChevronRight, SquareMinus, SquarePlus } from 'lucide-react'
import { contrastText } from '../utils/cidocColors.js'
import { useLanguageView } from '../hooks/useLanguageView.js'
import { allLanguages, getLangValue, hasLabelIn, hasExplorerLabelIn } from '../utils/languages.js'

// ── Language chips ───────────────────────────────────────────────────────────
//
// The entire multilingual UI on the canvas: one ~26px strip at the end of a
// label row. It carries two things at once, which is why it earns its space —
// which language the row is showing (outlined), and which languages already
// hold a value (solid vs. faded). Missing translations are therefore visible
// across the whole canvas without opening anything.
//
// Renders nothing at all when the project has a single language, so a
// monolingual project keeps exactly the node it had before.
function LangChips({ tags, active, filled, onPick, bgColor, what }) {
  if (!tags || tags.length < 2) return null
  return (
    <span
      onMouseDown={e => e.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, marginLeft: 1 }}
    >
      {tags.map(tag => {
        const isActive = tag === active
        const has = !!filled[tag]
        return (
          <button
            key={tag}
            onMouseDown={e => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPick(tag) }}
            title={`${what} in "${tag}" — ${has ? 'set' : 'not set yet'}${isActive ? ' (shown)' : ', click to edit'}`}
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 8, lineHeight: 1, letterSpacing: '0.03em',
              textTransform: 'uppercase', fontWeight: has ? 700 : 400,
              padding: '2px 3px', borderRadius: 2, cursor: 'pointer',
              border: `1px solid ${isActive ? '#b01f5f' : 'transparent'}`,
              background: isActive ? 'rgba(219,39,119,0.12)' : 'transparent',
              color: has ? '#7a2250' : adjustColor(bgColor, -55),
              opacity: has ? 1 : 0.5,
            }}
          >
            {tag}
          </button>
        )
      })}
    </span>
  )
}

export function OntologyNode({ id, data, selected }) {
  const { languages, activeLang } = useLanguageView()
  const langTags = allLanguages(languages)

  // Which language each of the two label rows currently shows. Both follow
  // the canvas-wide switch in the toolbar; clicking a chip overrides it for
  // that one row, until the toolbar switch moves again. The fallback to the
  // first tag covers the moment right after a language was removed from the
  // project while a row still pointed at it.
  const [labelLangRaw,    setLabelLang]    = useState(activeLang)
  const [explorerLangRaw, setExplorerLang] = useState(activeLang)
  useEffect(() => { setLabelLang(activeLang); setExplorerLang(activeLang) }, [activeLang])
  const labelLang    = langTags.includes(labelLangRaw)    ? labelLangRaw    : langTags[0]
  const explorerLang = langTags.includes(explorerLangRaw) ? explorerLangRaw : langTags[0]

  const storedLabel         = getLangValue(data, 'instanceLabel', labelLang,    languages)
  const storedLabelColumn   = getLangValue(data, 'labelColumn',   labelLang,    languages)
  const storedExplorerLabel = getLangValue(data, 'explorerLabel', explorerLang, languages)

  const [editingLabel, setEditingLabel] = useState(false)
  const [labelValue, setLabelValue]     = useState(storedLabel)
  const [overColumn, setOverColumn]     = useState(false)
  const [overLabel,  setOverLabel]      = useState(false)
  const [editingExplorerLabel, setEditingExplorerLabel] = useState(false)
  const [explorerLabelValue, setExplorerLabelValue]     = useState(storedExplorerLabel)

  useEffect(() => {
    setLabelValue(storedLabel)
  }, [storedLabel])

  useEffect(() => {
    setExplorerLabelValue(storedExplorerLabel)
  }, [storedExplorerLabel])

  // Fill state across ALL project languages — this is what lets the chips
  // double as a completeness indicator instead of being pure chrome.
  const labelFill    = Object.fromEntries(langTags.map(t => [t, hasLabelIn(data, t, languages)]))
  const explorerFill = Object.fromEntries(langTags.map(t => [t, hasExplorerLabelIn(data, t, languages)]))
  const anyLabel     = langTags.some(t => labelFill[t])
  const anyExplorer  = langTags.some(t => explorerFill[t])
  const labelComplete    = langTags.every(t => labelFill[t])
  const explorerComplete = langTags.every(t => explorerFill[t])

  const collapsed   = !!data.collapsed
  const bgColor     = data.nodeColor || '#ffffff'
  const textColor   = contrastText(bgColor)
  const borderColor = selected ? adjustColor(bgColor, -40) : adjustColor(bgColor, -25)
  const bodyBg      = mixWithWhite(bgColor, 0.15)

  // Every writer passes the row's language along. With one project language
  // that is always the primary, and the handlers write the same flat field
  // they always have.
  const handleLabelSubmit = () => {
    setEditingLabel(false)
    data.onLabelChange?.(id, labelValue, labelLang)
  }

  const handleExplorerLabelSubmit = () => {
    setEditingExplorerLabel(false)
    data.onExplorerLabelChange?.(id, explorerLabelValue, explorerLang)
  }

  // Explicit clear. Emptying the input and clicking away relies on the blur
  // firing, which is easy to miss (and leaves the field looking empty while
  // the old value is still stored and exported). These buttons write the
  // empty value straight through instead.
  const handleExplorerLabelClear = (e) => {
    e.stopPropagation()
    setExplorerLabelValue('')
    setEditingExplorerLabel(false)
    data.onExplorerLabelChange?.(id, '', explorerLang)
  }

  const handleInstanceLabelClear = (e) => {
    e.stopPropagation()
    setLabelValue('')
    setEditingLabel(false)
    data.onLabelChange?.(id, '', labelLang)
  }

  const dropZone = (zone) => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes('application/column')) return
      e.preventDefault(); e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      if (zone === 'column') setOverColumn(true)
      else if (zone === 'label') setOverLabel(true)
    },
    onDragLeave: (e) => {
      e.stopPropagation()
      if (zone === 'column') setOverColumn(false)
      else if (zone === 'label') setOverLabel(false)
    },
    onDrop: (e) => {
      const raw = e.dataTransfer.getData('application/column')
      if (!raw) return
      e.preventDefault(); e.stopPropagation()
      setOverColumn(false); setOverLabel(false)
      const col = JSON.parse(raw)
      // A column dropped on the label row lands in whichever language that
      // row is showing — the same gesture as before, no second drop target.
      if (zone === 'column') data.onColumnDrop?.(id, col)
      else if (zone === 'label') data.onLabelColumnDrop?.(id, col, labelLang)
    },
  })

  const hStyle = {
    background: borderColor,
    width: 9, height: 9,
    border: '2px solid #fff',
    borderRadius: '50%',
    zIndex: 10,
  }

  return (
    <div style={{ position: 'relative', minWidth: 170, maxWidth: 240 }}
      onDoubleClick={() => data.onFocus?.(id, data)}
    >
      <Handle id="l-t" type="target" position={Position.Left}   style={{ ...hStyle, left: -5,   top: '50%' }} />
      <Handle id="l-s" type="source" position={Position.Left}   style={{ ...hStyle, left: -5,   top: '50%' }} />
      <Handle id="r-t" type="target" position={Position.Right}  style={{ ...hStyle, right: -5,  top: '50%' }} />
      <Handle id="r-s" type="source" position={Position.Right}  style={{ ...hStyle, right: -5,  top: '50%' }} />
      <Handle id="t-t" type="target" position={Position.Top}    style={{ ...hStyle, top: -5,    left: '50%' }} />
      <Handle id="t-s" type="source" position={Position.Top}    style={{ ...hStyle, top: -5,    left: '50%' }} />
      <Handle id="b-t" type="target" position={Position.Bottom} style={{ ...hStyle, bottom: -5, left: '50%' }} />
      <Handle id="b-s" type="source" position={Position.Bottom} style={{ ...hStyle, bottom: -5, left: '50%' }} />

      <div style={{
        borderRadius: 6,
        boxShadow: selected
          ? `0 0 0 2px ${borderColor}, 0 6px 20px rgba(0,0,0,0.12)`
          : `0 0 0 1.5px ${borderColor}, 0 3px 10px rgba(0,0,0,0.08)`,
        transition: 'box-shadow 0.15s',
        cursor: 'pointer',
        overflow: 'hidden',
        fontFamily: "'IBM Plex Sans', sans-serif",
      }}>

        <div style={{
          background: bgColor,
          padding: '6px 10px 5px',
          display: 'flex', alignItems: 'center', gap: 5,
          borderBottom: collapsed ? 'none' : `1px solid ${borderColor}`,
        }}>
          {/* Collapse: purely visual. The node keeps every mapping and every
              edge — on a large canvas this is the difference between reading
              the structure and not. */}
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); data.onToggleCollapse?.(id) }}
            title={collapsed ? 'Expand node' : 'Collapse node — keeps all settings, only hides them'}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: 0, marginRight: 1, opacity: 0.55, color: textColor,
              display: 'flex', alignItems: 'center', flexShrink: 0,
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = 0.95}
            onMouseLeave={e => e.currentTarget.style.opacity = 0.55}
          >
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
          <span style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11, fontWeight: 600,
            color: textColor,
            flex: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            letterSpacing: '0.01em',
          }}>
            {data.label}
          </span>
          {/* Collapsed, the body is hidden — these dots keep the node honest
              about what is still configured on it. A dimmed label icon means
              the field is set in some, but not all, project languages: the
              same completeness signal the chips carry when expanded, at the
              cost of one extra state on an icon that was already there. */}
          {collapsed && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, opacity: 0.75 }}>
              {anyExplorer && <Globe2 size={9} color={textColor} style={{ opacity: explorerComplete ? 1 : 0.4 }} />}
              {anyLabel    && <Tag    size={9} color={textColor} style={{ opacity: labelComplete    ? 1 : 0.4 }} />}
              {data.mappedColumn && <Link2 size={9} color={textColor} />}
            </span>
          )}
          {/* Fold away the nodes hanging off this one. Only offered when the
              node actually owns children exclusively — see utils/collapse.js;
              a node whose children are shared would hide nothing. */}
          {(data.hasCollapsibleChildren || data.childrenCollapsed) && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); data.onToggleChildren?.(id) }}
              title={data.childrenCollapsed
                ? `Show the ${data.hiddenChildCount || 0} node(s) below this one again`
                : 'Hide the nodes hanging off this one (shared nodes stay visible)'}
              style={{
                display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
                background: data.childrenCollapsed ? 'rgba(0,0,0,0.14)' : 'transparent',
                border: 'none', borderRadius: 3, cursor: 'pointer',
                padding: data.childrenCollapsed ? '0 3px' : '0 2px',
                opacity: data.childrenCollapsed ? 0.95 : 0.45, color: textColor,
                fontSize: 9, fontFamily: "'IBM Plex Mono', monospace",
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = 0.95}
              onMouseLeave={e => e.currentTarget.style.opacity = data.childrenCollapsed ? 0.95 : 0.45}
            >
              {data.childrenCollapsed ? <SquarePlus size={10} /> : <SquareMinus size={10} />}
              {data.childrenCollapsed && (data.hiddenChildCount || 0) > 0 && <span>{data.hiddenChildCount}</span>}
            </button>
          )}
          {/* Re-class: swaps the ontology class only — edges, column mappings
              and all other node settings stay exactly as they are. */}
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); data.onChangeClass?.(id) }}
            title="Change class — keeps all connections, columns and labels"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '0 2px', opacity: 0.45, color: textColor,
              display: 'flex', alignItems: 'center', transition: 'opacity 0.1s',
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = 0.9}
            onMouseLeave={e => e.currentTarget.style.opacity = 0.45}
          >
            <Replace size={10} />
          </button>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); data.onDelete?.(id) }}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '0 2px', opacity: 0.45, color: textColor,
              display: 'flex', alignItems: 'center', transition: 'opacity 0.1s',
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = 0.9}
            onMouseLeave={e => e.currentTarget.style.opacity = 0.45}
          >
            <X size={11} />
          </button>
        </div>

        <div style={{
          background: bodyBg,
          padding: '6px 8px',
          display: collapsed ? 'none' : 'flex', flexDirection: 'column', gap: 4,
        }}>

          {/* Graph Explorer display name — overrides the CIDOC class name
              shown in the standalone Graph Explorer only (RDF export is
              unaffected). Lets identically-classed nodes used for
              different purposes (e.g. three E55_Type nodes for relation
              type / material / SE-Art) show up as distinct, readable
              types there. */}
          <div
            onMouseDown={e => e.stopPropagation()}
            title={`Display name in the Graph Explorer${langTags.length > 1 ? ` — language "${explorerLang}"` : ''} (replaces the CIDOC class there; the RDF export stays unchanged)`}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 6px', borderRadius: 4, minHeight: 22,
              border: `1px dashed ${adjustColor(bgColor, -35)}`,
              background: 'rgba(255,255,255,0.35)',
            }}
          >
            <Globe2 size={9} color={explorerLabelValue ? '#b01f5f' : adjustColor(bgColor, -50)} style={{ flexShrink: 0 }} />
            {editingExplorerLabel ? (
              <input
                autoFocus
                value={explorerLabelValue}
                onChange={e => setExplorerLabelValue(e.target.value)}
                onBlur={handleExplorerLabelSubmit}
                onKeyDown={e => e.key === 'Enter' && handleExplorerLabelSubmit()}
                onClick={e => e.stopPropagation()}
                style={{
                  fontSize: 10, padding: '1px 4px', flex: 1,
                  background: 'rgba(255,255,255,0.8)',
                  border: '1px solid rgba(0,0,0,0.2)',
                  borderRadius: 3, color: '#1a1a1a',
                  fontFamily: "'IBM Plex Sans', sans-serif",
                }}
                placeholder="e.g. Stratigraphic Unit"
              />
            ) : (
              <span
                onClick={(e) => { e.stopPropagation(); setEditingExplorerLabel(true) }}
                style={{
                  fontSize: 10,
                  color: explorerLabelValue ? darkenColor(bgColor, 60) : adjustColor(bgColor, -55),
                  flex: 1, cursor: 'text',
                  fontStyle: explorerLabelValue ? 'normal' : 'italic',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {explorerLabelValue || 'Explorer-Name…'}
              </span>
            )}
            {explorerLabelValue && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={handleExplorerLabelClear}
                title="Remove Explorer name — the node then uses its class name again"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', opacity: 0.5, color: '#b01f5f', display: 'flex', alignItems: 'center', flexShrink: 0 }}
              >
                <X size={9} />
              </button>
            )}
            <LangChips
              tags={langTags} active={explorerLang} filled={explorerFill}
              onPick={setExplorerLang} bgColor={bgColor} what="Explorer name"
            />
          </div>

          <div
            {...dropZone('label')}
            title={`Drop column → Domain_label / Range_Label${langTags.length > 1 ? ` (language "${labelLang}")` : ''}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 6px', borderRadius: 4, minHeight: 24,
              border: `1px ${overLabel ? 'solid' : 'dashed'} ${overLabel ? '#e8639d' : adjustColor(bgColor, -35)}`,
              background: overLabel ? 'rgba(219,39,119,0.1)' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.12s',
            }}
          >
            <Tag size={9}
              color={storedLabelColumn ? '#b01f5f' : overLabel ? '#e8639d' : adjustColor(bgColor, -50)}
              style={{ flexShrink: 0 }}
            />
            {storedLabelColumn ? (
              <>
                <span style={{
                  fontSize: 10, color: '#7a2250',
                  fontFamily: "'IBM Plex Mono', monospace",
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {storedLabelColumn}
                </span>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); data.onLabelColumnDrop?.(id, null, labelLang) }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', opacity: 0.5, color: '#b01f5f' }}
                >
                  <X size={9} />
                </button>
              </>
            ) : editingLabel ? (
              <input
                autoFocus
                value={labelValue}
                onChange={e => setLabelValue(e.target.value)}
                onBlur={handleLabelSubmit}
                onKeyDown={e => e.key === 'Enter' && handleLabelSubmit()}
                onClick={e => e.stopPropagation()}
                style={{
                  fontSize: 10, padding: '1px 4px', flex: 1,
                  background: 'rgba(255,255,255,0.8)',
                  border: '1px solid rgba(0,0,0,0.2)',
                  borderRadius: 3, color: '#1a1a1a',
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
                placeholder="Label / ID…"
              />
            ) : (
              <span
                onClick={(e) => { e.stopPropagation(); setEditingLabel(true) }}
                style={{
                  fontSize: 10,
                  color: labelValue ? darkenColor(bgColor, 60) : (overLabel ? '#b01f5f' : adjustColor(bgColor, -55)),
                  flex: 1, cursor: 'text',
                  fontStyle: labelValue ? 'normal' : 'italic',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  fontFamily: labelValue ? "'IBM Plex Mono', monospace" : 'inherit',
                }}
              >
                {labelValue
                  ? labelValue
                  : overLabel ? '← Drop label column'
                  : 'Label…'}
              </span>
            )}
            {!storedLabelColumn && labelValue && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={handleInstanceLabelClear}
                title="Remove label"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', opacity: 0.5, color: '#b01f5f', display: 'flex', alignItems: 'center', flexShrink: 0 }}
              >
                <X size={9} />
              </button>
            )}
            <LangChips
              tags={langTags} active={labelLang} filled={labelFill}
              onPick={setLabelLang} bgColor={bgColor} what="Label"
            />
          </div>

          <div
            {...dropZone('column')}
            title="Drop column → ID_of_Domain / ID_of_the_range"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 6px', borderRadius: 4, minHeight: 24,
              border: `1px ${overColumn ? 'solid' : 'dashed'} ${overColumn ? '#0f97a8' : adjustColor(bgColor, -35)}`,
              background: overColumn ? 'rgba(25,190,207,0.1)' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.12s',
            }}
          >
            <Link2 size={9}
              color={data.mappedColumn ? '#b01f5f' : overColumn ? '#0f97a8' : adjustColor(bgColor, -50)}
              style={{ flexShrink: 0 }}
            />
            {data.mappedColumn ? (
              <>
                <span style={{
                  fontSize: 10, color: '#7a2250',
                  fontFamily: "'IBM Plex Mono', monospace",
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {data.mappedColumn}
                </span>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); data.onColumnDrop?.(id, null) }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', opacity: 0.5, color: '#7a2250' }}
                >
                  <X size={9} />
                </button>
              </>
            ) : (
              <span style={{
                fontSize: 9,
                color: overColumn ? '#0b7d8b' : adjustColor(bgColor, -55),
                fontStyle: 'italic', flex: 1,
              }}>
                {overColumn ? '← Drop ID column' : 'ID column…'}
              </span>
            )}
          </div>

          {/* noPrefix toggle – for literal nodes (xsd:date, etc.) */}
          <div
            onMouseDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation()
              data.onToggleNoPrefix?.(id, !data.noPrefix)
            }}
            title={data.noPrefix
              ? 'Literal mode ON: No ID prefix prepended (values stay unchanged)'
              : 'Literal mode OFF: ID prefix will be prepended'}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
              fontSize: 9, userSelect: 'none',
              background: data.noPrefix ? 'rgba(25,190,207,0.1)' : 'transparent',
              color: data.noPrefix ? '#0f97a8' : adjustColor(bgColor, -50),
              border: `1px solid ${data.noPrefix ? 'rgba(15,151,168,0.25)' : 'transparent'}`,
              transition: 'all 0.12s',
            }}
          >
            <span style={{
              width: 10, height: 10, borderRadius: 2,
              border: `1.5px solid ${data.noPrefix ? '#0f97a8' : adjustColor(bgColor, -40)}`,
              background: data.noPrefix ? '#0f97a8' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 7, color: '#fff', fontWeight: 700,
            }}>
              {data.noPrefix ? '✓' : ''}
            </span>
            Literal (no prefix)
          </div>

        </div>
      </div>
    </div>
  )
}

// ── Dot-One Midpoint Node (small dot on edge) ────────────────────────────────
function DotOneMidpoint({ id, data }) {
  const dotStyle = {
    width: 14, height: 14, borderRadius: '50%',
    background: '#db2777', border: '2px solid #b01f5f',
    boxShadow: '0 0 6px rgba(219,39,119,0.3)',
    position: 'relative',
    cursor: 'default',
  }
  const hStyle = {
    background: '#db2777', width: 7, height: 7,
    border: '1.5px solid #fff', borderRadius: '50%', zIndex: 10,
  }
  return (
    <div style={dotStyle} title={data?.parentEdgeLabel ? `Dot-One on: ${data.parentEdgeLabel}` : 'Dot-One Midpoint'}>
      {/* Incoming handles (from split edge segments) */}
      <Handle id="mid-t-l" type="target" position={Position.Left}   style={{ ...hStyle, left: -4, top: '50%' }} />
      <Handle id="mid-t-t" type="target" position={Position.Top}    style={{ ...hStyle, top: -4, left: '50%' }} />
      <Handle id="mid-t-r" type="target" position={Position.Right}  style={{ ...hStyle, right: -4, top: '50%' }} />
      <Handle id="mid-t-b" type="target" position={Position.Bottom} style={{ ...hStyle, bottom: -4, left: '50%' }} />
      {/* Outgoing handles (to split edge segment + dot-one target) */}
      <Handle id="mid-s-l" type="source" position={Position.Left}   style={{ ...hStyle, left: -4, top: '50%' }} />
      <Handle id="mid-s-t" type="source" position={Position.Top}    style={{ ...hStyle, top: -4, left: '50%' }} />
      <Handle id="mid-s-r" type="source" position={Position.Right}  style={{ ...hStyle, right: -4, top: '50%' }} />
      <Handle id="mid-s-b" type="source" position={Position.Bottom} style={{ ...hStyle, bottom: -4, left: '50%' }} />
      {/* Dedicated dot-one outgoing handle */}
      <Handle id="dot-s" type="source" position={Position.Bottom} style={{ ...hStyle, bottom: -4, left: '50%' }} />
    </div>
  )
}

export const nodeTypes = {
  ontologyNode: OntologyNode,
  dotOneMidpoint: DotOneMidpoint,
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0,2), 16),
    parseInt(h.slice(2,4), 16),
    parseInt(h.slice(4,6), 16),
  ]
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2,'0')).join('')
}

function adjustColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r + amount, g + amount, b + amount)
}

function darkenColor(hex, amount) {
  return adjustColor(hex, -amount)
}

function mixWithWhite(hex, factor) {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r + (255-r)*factor, g + (255-g)*factor, b + (255-b)*factor)
}

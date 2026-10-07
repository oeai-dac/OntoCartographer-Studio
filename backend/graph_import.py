"""
graph_import.py — read an existing INSTANCE graph back into the Studio's model.

Lifts the graph onto the Studio's SCHEMA level: all instances sharing an
rdf:type collapse into ONE class group, and each distinct
(domainClass, predicate, rangeClass) pattern becomes ONE relation.

Every group is returned as a synthetic table, so the frontend can build
ordinary mapped nodes from it. That is the whole point of the design: an
imported graph enters through the SAME model a CSV upload produces, so
re-classing, re-connecting, verification and both exports keep working through
their existing code paths — there is no second export path that could drift.

Row layout per instance (see _expand_rows): literal values and relation targets
are laid out side by side, one value per row, with the identity columns
repeated. A multi-valued predicate therefore costs extra ROWS, never a
cartesian product. Downstream this makes the two export cases fall out exactly
right:

  * relation edges join ``srcRow[<predicate column>] == tgtRow["uri"]``
    (the explicit 2-key join, deduplicated on the domain/range pair, so the
    repeated identity columns cannot produce duplicate triples)
  * literal edges sit on the SAME table as their subject, so the row-by-row
    zip pairs every instance with its own value

RDF-star annotations (``<<S P O>> Q V .``) carry the Studio's Dot-One
information — for stratigraphic data that is the entire Harris matrix. rdflib
cannot parse them (see rewrite_star_syntax), so they are lifted out before
parsing and come back as a per-relation Dot-One column.

This module is deliberately free of FastAPI and of the ontology store: the
few helpers it needs are passed in, which keeps it independently testable.
"""

from typing import Dict, List, Set, Tuple

from rdflib import ConjunctiveGraph, URIRef, BNode
from rdflib.namespace import RDF, RDFS

XSD = "http://www.w3.org/2001/XMLSchema#"
UNTYPED_CLASS = str(RDFS.Resource)

# Placeholder vocabulary used to smuggle quoted triples past rdflib.
STAR_NS = "urn:ocstar:"
STAR_S = URIRef(STAR_NS + "subject")
STAR_P = URIRef(STAR_NS + "predicate")
STAR_O = URIRef(STAR_NS + "object")

DOT_SUFFIX = "__dot1"


class ImportError_(Exception):
    """Raised for input the caller should report as a 400."""


def looks_like_uri(value) -> bool:
    return isinstance(value, str) and (value.startswith("http://") or value.startswith("https://"))


# ─── RDF-star preprocessing ───────────────────────────────────────────────────

def _skip_quoted(text: str, i: int) -> int:
    """Advance past a Turtle string literal starting at i. Returns the index after it."""
    q = text[i]
    if text.startswith(q * 3, i):
        j = i + 3
        while j < len(text):
            if text[j] == "\\":
                j += 2
                continue
            if text.startswith(q * 3, j):
                return j + 3
            j += 1
        return len(text)
    j = i + 1
    while j < len(text):
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == q:
            return j + 1
        if text[j] == "\n":
            return j
        j += 1
    return len(text)


def _scan(text: str, i: int, stop_at_star_end: bool) -> int:
    """
    Walk Turtle/TriG text from i, skipping over comments, string literals and
    <IRI> tokens so that structural characters are only seen at top level.
    With stop_at_star_end, returns the index of the '>>' that closes the
    current quoted triple (handling nesting); otherwise runs to the end.
    """
    depth = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "#":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c in "\"'":
            i = _skip_quoted(text, i)
            continue
        if c == "<":
            if text.startswith("<<", i):
                depth += 1
                i += 2
                continue
            # A plain <IRI> token — never contains '>' unescaped.
            j = text.find(">", i)
            i = (j + 1) if j >= 0 else n
            continue
        if stop_at_star_end and text.startswith(">>", i):
            if depth == 0:
                return i
            depth -= 1
            i += 2
            continue
        i += 1
    return -1 if stop_at_star_end else n


def _split_terms(inner: str) -> List[str]:
    """Split the inside of a quoted triple into its three terms."""
    terms, i, n = [], 0, len(inner)
    while i < n:
        while i < n and inner[i].isspace():
            i += 1
        if i >= n:
            break
        start = i
        c = inner[i]
        if c in "\"'":
            i = _skip_quoted(inner, i)
            # a literal may carry a language tag or ^^datatype
            while i < n and not inner[i].isspace():
                if inner[i] == "<":
                    j = inner.find(">", i)
                    i = (j + 1) if j >= 0 else n
                else:
                    i += 1
        elif c == "<":
            j = inner.find(">", i)
            i = (j + 1) if j >= 0 else n
        else:
            while i < n and not inner[i].isspace():
                i += 1
        terms.append(inner[start:i])
    return terms


def rewrite_star_syntax(text: str) -> Tuple[str, int, bool]:
    """
    rdflib's Turtle/TriG parser has no RDF-star support: it reads the leading
    '<' of '<<' as the start of an IRI and then fails at the closing '>>'.

    Every quoted triple is therefore replaced by a placeholder IRI, and its
    three components are appended as ordinary triples. rdflib can then read the
    whole document, and the annotation is reconstructed afterwards from the
    placeholder. The quoted triple itself is also asserted, because the Studio
    models a Dot-One as an annotation ON an existing relation.

    Prefix declarations stay in scope for the rest of the document, so the
    appended block may use the same prefixed names as the original statements.

    Returns (rewritten text, number of quoted triples, saw '{|' syntax).
    """
    has_annotation_syntax = "{|" in text
    if "<<" not in text:
        return text, 0, has_annotation_syntax

    out, extra = [], []
    i, n, count = 0, len(text), 0
    while i < n:
        c = text[i]
        if c == "#":
            j = text.find("\n", i)
            j = n if j < 0 else j + 1
            out.append(text[i:j]); i = j
            continue
        if c in "\"'":
            j = _skip_quoted(text, i)
            out.append(text[i:j]); i = j
            continue
        if text.startswith("<<", i):
            end = _scan(text, i + 2, stop_at_star_end=True)
            if end < 0:
                out.append(text[i:]); break
            inner = text[i + 2:end]
            terms = _split_terms(inner)
            if len(terms) != 3:
                # Not something we can lift out — leave it and let rdflib complain.
                out.append(text[i:end + 2]); i = end + 2
                continue
            count += 1
            node = "<%s%d>" % (STAR_NS, count)
            out.append(node)
            extra.append("%s <%s> %s ; <%s> %s ; <%s> %s .\n%s %s %s .\n" % (
                node, STAR_S, terms[0], STAR_P, terms[1], STAR_O, terms[2],
                terms[0], terms[1], terms[2]))
            i = end + 2
            continue
        if c == "<":
            j = text.find(">", i)
            j = n if j < 0 else j + 1
            out.append(text[i:j]); i = j
            continue
        out.append(c)
        i += 1

    return "".join(out) + "\n" + "".join(extra), count, has_annotation_syntax


# ─── Shared helpers ───────────────────────────────────────────────────────────

def _unique_column(base: str, taken: Set[str]) -> str:
    """Local names collide across namespaces — suffix instead of overwriting."""
    name = base or "value"
    if name not in taken:
        taken.add(name)
        return name
    i = 2
    while "%s#%d" % (name, i) in taken:
        i += 1
    name = "%s#%d" % (name, i)
    taken.add(name)
    return name


def _most_specific_class(candidates: List[str], superclasses: Dict[str, Set[str]]) -> str:
    """
    Pick the most specific rdf:type. With an ontology loaded this drops every
    candidate that is a transitive superclass of another candidate; otherwise
    it falls back to a deterministic choice so repeated imports stay stable.
    """
    cands = sorted({c for c in candidates if c})
    if not cands:
        return UNTYPED_CLASS
    if len(cands) == 1:
        return cands[0]
    specific = [c for c in cands
                if not any(c in superclasses.get(other, set()) for other in cands if other != c)]
    return sorted(specific)[0] if specific else cands[0]


def _new_group() -> dict:
    return {"instances": [], "rel_cols": set(), "lit_cols": set(), "dot_cols": set(), "taken": set()}


def _expand_rows(instances: List[dict], cols: List[str]) -> List[dict]:
    """
    One row per value slot: an instance with 3 notes and 2 relation targets
    yields 3 rows (identity columns repeated, shorter lists padded with '').
    Linear in the number of statements — never a cartesian product.
    """
    rows = []
    for inst in instances:
        vals = inst["values"]
        counts = [len(vals.get(c, ())) for c in cols]
        n = max([c for c in counts if c > 0], default=0) or 1
        for i in range(n):
            row = {"uri": inst["uri"], "label": inst["label"]}
            for col in cols:
                v = vals.get(col, ())
                row[col] = v[i] if i < len(v) else ""
            rows.append(row)
    return rows


def _build_payload(groups, relations, literals, warnings, source, prefix_label) -> dict:
    """Turn the collected groups into the table/relation payload the frontend consumes."""

    def lbl(uri: str) -> str:
        return prefix_label(uri) if looks_like_uri(uri) else uri

    classes, total_rows = [], 0
    for idx, (class_uri, grp) in enumerate(
            sorted(groups.items(), key=lambda kv: (-len(kv[1]["instances"]), kv[0]))):
        rel_cols = sorted(grp["rel_cols"])
        lit_cols = sorted(grp["lit_cols"])
        dot_cols = sorted(grp["dot_cols"])
        rows = _expand_rows(grp["instances"], rel_cols + lit_cols + dot_cols)
        total_rows += len(rows)
        # Full URIs must bypass the ID prefix; opaque ids (a Graph-Explorer
        # JSON may use "B_1989_2") need it to become resolvable at all.
        ids_are_uris = bool(grp["instances"]) and all(
            looks_like_uri(i["uri"]) for i in grp["instances"][:50])
        classes.append({
            "class_uri":      class_uri,
            "label":          lbl(class_uri),
            "table_id":       "imp_%d" % (idx + 1),
            "table_name":     "%s (%d)" % (lbl(class_uri), len(grp["instances"])),
            "id_column":      "uri",
            "label_column":   "label",
            "no_prefix":      ids_are_uris,
            "instance_count": len(grp["instances"]),
            "headers":        ["uri", "label"] + rel_cols + lit_cols + dot_cols,
            "rows":           rows,
        })

    known = {c["class_uri"] for c in classes}

    rel_out = []
    for r in sorted(relations.values(), key=lambda r: -r["count"]):
        if r["domain_class"] not in known or r["range_class"] not in known:
            continue
        entry = {
            "property_uri": r["property_uri"],
            "label":        lbl(r["property_uri"]),
            "domain_class": r["domain_class"],
            "range_class":  r["range_class"],
            "join_column":  r["column"],
            "count":        r["count"],
            "dot_one":      None,
        }
        # Dot-One: the annotation property seen most often on this relation.
        if r.get("dot_props"):
            prop = max(r["dot_props"].items(), key=lambda kv: kv[1])[0]
            if len(r["dot_props"]) > 1:
                warnings.append(
                    "Relation %s carries %d different annotation properties; %s is used."
                    % (lbl(r["property_uri"]), len(r["dot_props"]), lbl(prop)))
            entry["dot_one"] = {
                "property_uri": prop,
                "label":        lbl(prop),
                "column":       r["column"] + DOT_SUFFIX,
                "count":        r["dot_count"],
            }
        rel_out.append(entry)

    lit_out = [{
        "property_uri":   l["property_uri"],
        "label":          lbl(l["property_uri"]),
        "domain_class":   l["domain_class"],
        "datatype":       l["datatype"],
        "datatype_label": lbl(l["datatype"]),
        "column":         l["column"],
        "count":          l["count"],
    } for l in sorted(literals.values(), key=lambda l: -l["count"]) if l["domain_class"] in known]

    non_uri_classes = [c["class_uri"] for c in classes if not looks_like_uri(c["class_uri"])]
    if non_uri_classes:
        warnings.append(
            "%d class(es) carry no URI (%s%s). They import as free classes — assign a CIDOC class "
            "via the node's replace button before exporting RDF."
            % (len(non_uri_classes), ", ".join(non_uri_classes[:4]),
               "…" if len(non_uri_classes) > 4 else ""))

    non_uri_props = sorted({r["property_uri"] for r in rel_out if not looks_like_uri(r["property_uri"])})
    if non_uri_props:
        warnings.append(
            "%d propert(y/ies) carry no URI (%s%s). Set a property URI by double-clicking the connection."
            % (len(non_uri_props), ", ".join(non_uri_props[:4]),
               "…" if len(non_uri_props) > 4 else ""))

    if total_rows > 50000:
        warnings.append("%d table rows imported — the canvas stays small, but exports may take a moment."
                        % total_rows)

    dot_total = sum(r["dot_one"]["count"] for r in rel_out if r["dot_one"])
    return {
        "source":    source,
        "classes":   classes,
        "relations": rel_out,
        "literals":  lit_out,
        "warnings":  warnings,
        "stats": {
            "class_count":    len(classes),
            "relation_count": len(rel_out),
            "literal_count":  len(lit_out),
            "instance_count": sum(c["instance_count"] for c in classes),
            "row_count":      total_rows,
            "dot_one_count":  dot_total,
        },
    }


# ─── RDF ──────────────────────────────────────────────────────────────────────

FORMAT_BY_EXT = {
    "ttl": ["turtle", "n3"], "n3": ["n3", "turtle"],
    "rdf": ["xml"], "owl": ["xml"], "xml": ["xml"],
    "nt": ["nt"], "nq": ["nquads"], "trig": ["trig"], "jsonld": ["json-ld"],
}
FORMAT_FALLBACK = ["turtle", "xml", "nt", "trig", "nquads", "json-ld", "n3"]


def parse_rdf(content: bytes, filename: str) -> Tuple[ConjunctiveGraph, int, bool, int]:
    """
    Parse into a ConjunctiveGraph, never a plain Graph: TriG/N-Quads put their
    statements into NAMED graphs, and a plain Graph silently keeps only the
    default graph — an 18 MB TriG then arrives as a handful of triples.
    Iterating a ConjunctiveGraph yields plain triples across all contexts.
    """
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    text = content.decode("utf-8", errors="replace")
    text, star_count, has_annotation_syntax = rewrite_star_syntax(text)
    last_err = None
    for fmt in FORMAT_BY_EXT.get(ext, FORMAT_FALLBACK):
        try:
            g = ConjunctiveGraph()
            g.parse(data=text, format=fmt)
            context_count = sum(1 for _ in g.contexts())
            return g, star_count, has_annotation_syntax, context_count
        except Exception as exc:          # try the next candidate syntax
            last_err = exc
    raise ImportError_("Could not parse '%s' as RDF: %s" % (filename, last_err))


def _collect_star_annotations(g: ConjunctiveGraph) -> Tuple[Dict[Tuple[str, str, str], List[Tuple[str, str]]], Set[str]]:
    """
    Rebuild the RDF-star annotations from the placeholder nodes and remove the
    scaffolding from the graph, so the rest of the import never sees it.
    """
    ann: Dict[Tuple[str, str, str], List[Tuple[str, str]]] = {}
    star_nodes = set()
    for node in set(g.subjects(STAR_S, None)):
        s = g.value(node, STAR_S)
        p = g.value(node, STAR_P)
        o = g.value(node, STAR_O)
        star_nodes.add(str(node))
        if s is None or p is None or o is None:
            continue
        key = (str(s), str(p), str(o))
        for ap, av in g.predicate_objects(node):
            if ap in (STAR_S, STAR_P, STAR_O):
                continue
            ann.setdefault(key, []).append((str(ap), str(av)))
    for node in list(star_nodes):
        g.remove((URIRef(node), None, None))
    return ann, star_nodes


def import_rdf(content: bytes, filename: str, superclasses, local_name, prefix_label) -> dict:
    g, star_count, has_annotation_syntax, context_count = parse_rdf(content, filename)
    warnings: List[str] = []

    annotations, star_nodes = _collect_star_annotations(g)
    if star_count:
        warnings.append("%d RDF-star annotation(s) read and kept as Dot-One on their connection."
                        % star_count)
    if context_count > 1:
        warnings.append("%d named graphs merged into one canvas — graph membership is not restored. "
                        "Re-group nodes via the Graphs panel if you need it." % context_count)
    if has_annotation_syntax:
        warnings.append("The file also uses the '{| … |}' annotation syntax, which is not supported — "
                        "those qualifiers are missing.")

    # 1. Assign every resource to exactly one class group.
    types: Dict[str, List[str]] = {}
    for s, _, o in g.triples((None, RDF.type, None)):
        if isinstance(s, BNode):
            continue
        types.setdefault(str(s), []).append(str(o))

    resources: Set[str] = set()
    bnode_stmts = 0
    for s, p, o in g:
        if isinstance(s, BNode) or isinstance(o, BNode):
            bnode_stmts += 1
            continue
        resources.add(str(s))
        if isinstance(o, URIRef) and p != RDF.type:
            resources.add(str(o))
    resources -= star_nodes
    if bnode_stmts:
        warnings.append("%d statement(s) with blank nodes skipped — the Studio has no blank-node model."
                        % bnode_stmts)

    class_of = {r: (_most_specific_class(types[r], superclasses) if r in types else UNTYPED_CLASS)
                for r in resources}
    untyped = sum(1 for r in resources if r not in types)
    if untyped:
        warnings.append("%d resource(s) without rdf:type collected under rdfs:Resource — re-class as needed."
                        % untyped)

    groups: Dict[str, dict] = {}
    inst_of: Dict[str, dict] = {}
    for res in sorted(resources):
        grp = groups.setdefault(class_of[res], _new_group())
        inst = {"uri": res, "label": "", "values": {}}
        grp["instances"].append(inst)
        inst_of[res] = inst

    # 2. Collect per-instance values, creating one column per predicate.
    relations: Dict[tuple, dict] = {}
    literals: Dict[tuple, dict] = {}
    col_of_pred: Dict[tuple, str] = {}

    for s, p, o in sorted(g, key=lambda t: (str(t[0]), str(t[1]), str(t[2]))):
        if isinstance(s, BNode) or isinstance(o, BNode) or p == RDF.type:
            continue
        su = str(s)
        inst = inst_of.get(su)
        if inst is None:
            continue
        if p == RDFS.label and not isinstance(o, URIRef):
            if not inst["label"]:
                inst["label"] = str(o)
            continue

        cu = class_of[su]
        grp = groups[cu]
        pu = str(p)
        is_rel = isinstance(o, URIRef)
        key = (cu, pu, "rel" if is_rel else "lit")
        col = col_of_pred.get(key)
        if col is None:
            col = _unique_column(local_name(pu), grp["taken"])
            col_of_pred[key] = col
            (grp["rel_cols"] if is_rel else grp["lit_cols"]).add(col)

        inst["values"].setdefault(col, []).append(str(o))

        if is_rel:
            ou = str(o)
            rc = class_of.get(ou, UNTYPED_CLASS)
            rel = relations.setdefault((cu, pu, rc), {"property_uri": pu, "domain_class": cu,
                                                      "range_class": rc, "column": col, "count": 0,
                                                      "dot_props": {}, "dot_count": 0})
            rel["count"] += 1

            # Dot-One value for exactly this statement, parked in a parallel
            # column so it lines up with the relation value of the same row.
            dot_col = col + DOT_SUFFIX
            anns = annotations.get((su, pu, ou))
            if anns:
                ap, av = anns[0]
                grp["dot_cols"].add(dot_col)
                rel["dot_props"][ap] = rel["dot_props"].get(ap, 0) + 1
                rel["dot_count"] += 1
                inst["values"].setdefault(dot_col, []).append(av)
            elif dot_col in grp["dot_cols"]:
                inst["values"].setdefault(dot_col, []).append("")
        else:
            dt = str(o.datatype) if getattr(o, "datatype", None) else XSD + "string"
            lit = literals.setdefault((cu, pu, dt), {"property_uri": pu, "domain_class": cu,
                                                     "datatype": dt, "column": col, "count": 0})
            lit["count"] += 1

    # A Dot-One column discovered late must still line up with its relation
    # column for the rows written before it existed — pad from the front.
    for grp in groups.values():
        for inst in grp["instances"]:
            for dot_col in grp["dot_cols"]:
                rel_col = dot_col[:-len(DOT_SUFFIX)]
                have = inst["values"].get(dot_col)
                need = len(inst["values"].get(rel_col, ()))
                if need == 0:
                    continue
                if have is None:
                    inst["values"][dot_col] = [""] * need
                elif len(have) < need:
                    inst["values"][dot_col] = [""] * (need - len(have)) + have

    for inst in inst_of.values():
        if not inst["label"]:
            inst["label"] = local_name(inst["uri"])

    return _build_payload(groups, relations, literals, warnings, "rdf", prefix_label)


# ─── Graph-Explorer JSON ──────────────────────────────────────────────────────

def _strip_marks(key: str) -> str:
    # "<uri>#as:custom_name" is a display override, "<uri>#dot1:value" a
    # qualified relation — both reduce to the underlying URI here.
    return key.split("#as:")[0].split("#dot1:")[0]


def import_graph_json(data: dict, local_name, prefix_label) -> dict:
    """Read the Graph-Explorer JSON (see docs/graph-json-format.md) back in."""
    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, dict) or not nodes:
        raise ImportError_("Not a Graph-Explorer JSON: the 'nodes' object is missing or empty.")

    warnings: List[str] = []
    dot1 = sum(1 for n in nodes.values() for k in (n.get("o") or {}) if "#dot1:" in k)
    if dot1:
        warnings.append("%d Dot-One relation(s) imported as plain connections — the qualifier is not "
                        "restored (import the RDF instead to keep it)." % dot1)

    class_of = {nid: (_strip_marks(n.get("t") or "") or UNTYPED_CLASS) for nid, n in nodes.items()}

    groups: Dict[str, dict] = {}
    inst_of: Dict[str, dict] = {}
    for nid in sorted(nodes):
        grp = groups.setdefault(class_of[nid], _new_group())
        inst = {"uri": nid, "label": nodes[nid].get("l") or nid, "values": {}}
        grp["instances"].append(inst)
        inst_of[nid] = inst

    relations: Dict[tuple, dict] = {}
    literals: Dict[tuple, dict] = {}
    col_of_pred: Dict[tuple, str] = {}

    for nid, n in nodes.items():
        cu = class_of[nid]
        grp = groups[cu]
        inst = inst_of[nid]

        for attr, value in (n.get("a") or {}).items():
            key = (cu, attr, "lit")
            col = col_of_pred.get(key)
            if col is None:
                col = _unique_column(attr, grp["taken"])
                col_of_pred[key] = col
                grp["lit_cols"].add(col)
            inst["values"].setdefault(col, []).append("" if value is None else str(value))
            dt = XSD + "string"
            lit = literals.setdefault((cu, attr, dt), {"property_uri": attr, "domain_class": cu,
                                                       "datatype": dt, "column": col, "count": 0})
            lit["count"] += 1

        for edge_key, targets in (n.get("o") or {}).items():
            pu = _strip_marks(edge_key)
            key = (cu, pu, "rel")
            col = col_of_pred.get(key)
            if col is None:
                col = _unique_column(local_name(pu) if looks_like_uri(pu) else pu, grp["taken"])
                col_of_pred[key] = col
                grp["rel_cols"].add(col)
            for tgt in (targets or []):
                if tgt not in class_of:
                    continue
                inst["values"].setdefault(col, []).append(tgt)
                rc = class_of[tgt]
                rel = relations.setdefault((cu, pu, rc), {"property_uri": pu, "domain_class": cu,
                                                          "range_class": rc, "column": col, "count": 0,
                                                          "dot_props": {}, "dot_count": 0})
                rel["count"] += 1

    return _build_payload(groups, relations, literals, warnings, "graph-json", prefix_label)

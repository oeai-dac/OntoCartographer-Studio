"""
Ontology Mapper Backend – FastAPI + rdflib
Includes full rdfs:subClassOf inference (transitive ancestor walk).

Run with: uvicorn main:app --reload --port 8000
"""

import re
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional, Dict, Set, Tuple

try:
    from rdflib import Graph, URIRef, BNode
    from rdflib.namespace import RDF, RDFS, OWL
    RDFLIB_AVAILABLE = True
except ImportError:
    RDFLIB_AVAILABLE = False

app = FastAPI(title="OntoCartographer Studio API", version="3.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store
ontology_store: Dict = {
    "graphs": {},   # filename -> rdflib.Graph
    "merged": None, # single merged graph
    # Inference cache – rebuilt whenever merged changes
    "_superclasses": {},   # uri -> set of all transitive superclass uris
    "_subclasses":   {},   # uri -> set of all transitive subclass uris
    "_prop_domains": {},   # property_uri -> set of direct domain uris
    "_prop_ranges":  {},   # property_uri -> set of direct range uris (incl. union expansion)
    "_all_props":    set(), # set of all property uris
    "_inverse_of":   {},   # property_uri -> inverse property_uri (owl:inverseOf, both directions)
}

# ─── URI / Label helpers ──────────────────────────────────────────────────────

def get_local_name(uri: str) -> str:
    if "#" in uri:
        return uri.split("#")[-1]
    return uri.split("/")[-1]


def get_namespaces() -> dict:
    if not ontology_store["merged"]:
        return {}
    return {prefix: str(ns) for prefix, ns in ontology_store["merged"].namespaces()}


def get_prefix_label(uri: str, namespaces: dict) -> str:
    # Sort by length descending so longer (more specific) prefixes match first
    for prefix, ns_uri in sorted(namespaces.items(), key=lambda x: -len(x[1])):
        if uri.startswith(ns_uri):
            local = uri[len(ns_uri):]
            if local and "/" not in local and "#" not in local:
                return f"{prefix}:{local}" if prefix else local
    return get_local_name(uri)


def _preferred_literal(graph: Graph, uri_ref, predicate, lang_prefs=("de", "en", "")):
    """Return the best literal for a predicate, preferring languages in order.
    lang_prefs=("de","en","") means: try German first, then English, then any."""
    candidates = list(graph.objects(uri_ref, predicate))
    if not candidates:
        return None
    for lang in lang_prefs:
        if lang == "":
            # Accept any remaining candidate (fallback)
            return candidates[0]
        for c in candidates:
            c_lang = getattr(c, 'language', None)
            if c_lang == lang:
                return c
    # Fallback: return first available
    return candidates[0] if candidates else None


def _literal_in_lang(graph: Graph, uri_ref, predicate, lang: str):
    """Return the literal tagged with exactly `lang`, or None.

    Deliberately strict, unlike _preferred_literal: when building a
    per-language label map, a fallback would copy the same text into every
    language and make an untranslated ontology look fully translated.
    """
    if not lang:
        return None
    for c in graph.objects(uri_ref, predicate):
        if getattr(c, "language", None) == lang:
            return c
    return None


def uri_to_dict(uri: str, graph: Graph, ns: dict) -> dict:
    label = get_prefix_label(uri, ns)
    uri_ref = URIRef(uri)
    rdfs_label = _preferred_literal(graph, uri_ref, RDFS.label)
    rdfs_comment = _preferred_literal(graph, uri_ref, RDFS.comment)
    return {
        "uri": uri,
        "label": label,
        "rdfs_label": str(rdfs_label) if rdfs_label else None,
        "rdfs_comment": str(rdfs_comment) if rdfs_comment else None,
    }

# ─── Inference Engine ─────────────────────────────────────────────────────────

# OWL / RDFS meta-classes we never want as user-facing classes
_META_URIS = {
    str(OWL.Class), str(RDFS.Class),
    str(OWL.ObjectProperty), str(OWL.DatatypeProperty),
    str(OWL.AnnotationProperty), str(OWL.TransitiveProperty),
    str(OWL.SymmetricProperty), str(OWL.FunctionalProperty),
    str(OWL.InverseFunctionalProperty), str(OWL.Restriction),
    str(RDF.Property), str(OWL.Ontology),
    str(RDFS.Resource), str(RDFS.Literal),
    str(OWL.Thing), str(OWL.Nothing),
}


def _collect_all_classes(graph: Graph) -> Set[str]:
    """Collect every URI that is used as a class."""
    classes: Set[str] = set()

    for s in graph.subjects(RDF.type, OWL.Class):
        if isinstance(s, URIRef):
            classes.add(str(s))
    for s in graph.subjects(RDF.type, RDFS.Class):
        if isinstance(s, URIRef):
            classes.add(str(s))
    # Anything declared as a subClassOf something
    for s in graph.subjects(RDFS.subClassOf, None):
        if isinstance(s, URIRef):
            classes.add(str(s))
    for o in graph.objects(None, RDFS.subClassOf):
        if isinstance(o, URIRef):
            classes.add(str(o))
    # Anything used as domain or range
    for o in graph.objects(None, RDFS.domain):
        if isinstance(o, URIRef):
            classes.add(str(o))
    for o in graph.objects(None, RDFS.range):
        if isinstance(o, URIRef):
            classes.add(str(o))

    return classes - _META_URIS


def _build_subclass_index(graph: Graph, all_classes: Set[str]) -> tuple[dict, dict]:
    """
    Build two indexes:
      direct_super[C] = set of direct superclasses of C
      direct_sub[C]   = set of direct subclasses of C
    from rdfs:subClassOf triples only (BNode restrictions are skipped).
    """
    direct_super: Dict[str, Set[str]] = {c: set() for c in all_classes}
    direct_sub:   Dict[str, Set[str]] = {c: set() for c in all_classes}

    for s, _, o in graph.triples((None, RDFS.subClassOf, None)):
        if isinstance(s, URIRef) and isinstance(o, URIRef):
            cs, co = str(s), str(o)
            if cs in _META_URIS or co in _META_URIS:
                continue
            # Ensure keys exist even if class wasn't in initial set
            direct_super.setdefault(cs, set()).add(co)
            direct_sub.setdefault(co, set()).add(cs)
            direct_super.setdefault(co, set())
            direct_sub.setdefault(cs, set())

    return direct_super, direct_sub


def _transitive_closure(start: str, adjacency: Dict[str, Set[str]]) -> Set[str]:
    """
    BFS / iterative DFS over adjacency to collect all reachable nodes
    (excluding start itself).  Handles cycles safely.
    """
    visited: Set[str] = set()
    stack = list(adjacency.get(start, set()))
    while stack:
        node = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        stack.extend(adjacency.get(node, set()) - visited)
    return visited


def _expand_union(node, graph: Graph, _seen=None) -> Set[str]:
    """Expand owl:unionOf BNode into its member URIs, recursing into nested
    owl:unionOf members (which are themselves BNodes) so deeply nested unions
    aren't silently dropped. Guarded against cyclic BNode structures."""
    members: Set[str] = set()
    if _seen is None:
        _seen = set()
    if node in _seen:
        return members
    _seen.add(node)
    union = graph.value(node, OWL.unionOf)
    if union:
        for item in graph.items(union):
            if isinstance(item, URIRef):
                members.add(str(item))
            elif isinstance(item, BNode):
                members |= _expand_union(item, graph, _seen)
    return members


def _build_property_indexes(graph: Graph) -> tuple[dict, dict, set, dict]:
    """
    Build:
      prop_domains[p] = set of direct domain URIs (union-expanded, inverse-inferred)
      prop_ranges[p]  = set of direct range  URIs (union-expanded, inverse-inferred)
      all_props       = set of all property URIs
      inverse_of[p]   = the owl:inverseOf partner of p, if declared (either direction)

    owl:inverseOf inference
    ────────────────────────
    CRM extension ontologies (CRMarchaeo, CRMsci, …) often declare inverse
    properties without repeating domain/range – they rely on the rule:

        P owl:inverseOf Q  →  domain(P) = range(Q),  range(P) = domain(Q)

    We resolve this in two passes so that chains like
        AP3i owl:inverseOf AP3 ;  AP3 rdfs:domain A9 ; rdfs:range E27
    are fully expanded even when AP3i has no explicit domain/range triples.

    We also handle the symmetric direction: if Q owl:inverseOf P is stated
    on the forward property instead of the inverse.
    """
    prop_domains: Dict[str, Set[str]] = {}
    prop_ranges:  Dict[str, Set[str]] = {}
    all_props:    Set[str] = set()

    property_types = [
        OWL.ObjectProperty, OWL.DatatypeProperty,
        OWL.AnnotationProperty, RDF.Property,
    ]

    # ── Pass 1: collect all known properties ─────────────────────────────────
    for ptype in property_types:
        for p in graph.subjects(RDF.type, ptype):
            if not isinstance(p, URIRef):
                continue
            ps = str(p)
            all_props.add(ps)
            prop_domains.setdefault(ps, set())
            prop_ranges.setdefault(ps, set())

    # Also pick up properties that only appear in domain/range triples
    for p in graph.subjects(RDFS.domain, None):
        if isinstance(p, URIRef):
            all_props.add(str(p))
            prop_domains.setdefault(str(p), set())
            prop_ranges.setdefault(str(p), set())
    for p in graph.subjects(RDFS.range, None):
        if isinstance(p, URIRef):
            all_props.add(str(p))
            prop_domains.setdefault(str(p), set())
            prop_ranges.setdefault(str(p), set())

    # Also register any property mentioned in owl:inverseOf triples
    for s, _, o in graph.triples((None, OWL.inverseOf, None)):
        for node in (s, o):
            if isinstance(node, URIRef):
                ns = str(node)
                all_props.add(ns)
                prop_domains.setdefault(ns, set())
                prop_ranges.setdefault(ns, set())

    # ── Pass 2: fill direct domain / range from explicit triples ─────────────
    for p in list(all_props):
        for domain_node in graph.objects(URIRef(p), RDFS.domain):
            if isinstance(domain_node, URIRef):
                prop_domains[p].add(str(domain_node))
            elif isinstance(domain_node, BNode):
                prop_domains[p].update(_expand_union(domain_node, graph))

    for p in list(all_props):
        for range_node in graph.objects(URIRef(p), RDFS.range):
            if isinstance(range_node, URIRef):
                prop_ranges[p].add(str(range_node))
            elif isinstance(range_node, BNode):
                prop_ranges[p].update(_expand_union(range_node, graph))

    # ── Pass 3: owl:inverseOf inference (iterate to fixpoint) ────────────────
    # Collect all inverseOf pairs (both directions: P inv Q and Q inv P)
    inverse_pairs: List[Tuple[str, str]] = []
    for s, _, o in graph.triples((None, OWL.inverseOf, None)):
        if isinstance(s, URIRef) and isinstance(o, URIRef):
            ps, po = str(s), str(o)
            inverse_pairs.append((ps, po))   # P inverseOf Q
            inverse_pairs.append((po, ps))   # symmetric: Q inverseOf P

    # Iterate until no new information is added (handles chains)
    changed = True
    while changed:
        changed = False
        for p_inv, p_fwd in inverse_pairs:
            # domain(p_inv) ← range(p_fwd)
            new_domains = prop_ranges.get(p_fwd, set()) - prop_domains.get(p_inv, set())
            if new_domains:
                prop_domains.setdefault(p_inv, set()).update(new_domains)
                all_props.add(p_inv)
                changed = True

            # range(p_inv) ← domain(p_fwd)
            new_ranges = prop_domains.get(p_fwd, set()) - prop_ranges.get(p_inv, set())
            if new_ranges:
                prop_ranges.setdefault(p_inv, set()).update(new_ranges)
                all_props.add(p_inv)
                changed = True

    # p_inv/p_fwd pairs already include both directions, so a plain dict build
    # yields a symmetric mapping (inverse_of[P] = Q and inverse_of[Q] = P).
    inverse_of: Dict[str, str] = {}
    for p_inv, p_fwd in inverse_pairs:
        inverse_of.setdefault(p_inv, p_fwd)

    return prop_domains, prop_ranges, all_props, inverse_of


def rebuild_merged():
    """
    Rebuild the merged graph and all inference caches.
    Called after every upload or delete.
    """
    merged = Graph()
    for g in ontology_store["graphs"].values():
        for triple in g:
            merged.add(triple)
        for prefix, ns in g.namespaces():
            merged.bind(prefix, ns, override=False)
    ontology_store["merged"] = merged

    if not merged:
        ontology_store["_superclasses"] = {}
        ontology_store["_subclasses"]   = {}
        ontology_store["_prop_domains"] = {}
        ontology_store["_prop_ranges"]  = {}
        ontology_store["_all_props"]    = set()
        ontology_store["_inverse_of"]   = {}
        return

    # --- Class hierarchy ---
    all_classes = _collect_all_classes(merged)
    direct_super, direct_sub = _build_subclass_index(merged, all_classes)

    # Transitive closures
    superclasses: Dict[str, Set[str]] = {}
    subclasses:   Dict[str, Set[str]] = {}
    for c in all_classes:
        superclasses[c] = _transitive_closure(c, direct_super)
        subclasses[c]   = _transitive_closure(c, direct_sub)

    ontology_store["_superclasses"] = superclasses
    ontology_store["_subclasses"]   = subclasses

    # --- Property indexes ---
    pd, pr, ap, inv = _build_property_indexes(merged)
    ontology_store["_prop_domains"] = pd
    ontology_store["_prop_ranges"]  = pr
    ontology_store["_all_props"]    = ap
    ontology_store["_inverse_of"]   = inv

# ─── Query functions (use inference caches) ───────────────────────────────────

def get_all_classes_dicts() -> List[dict]:
    g  = ontology_store["merged"]
    ns = get_namespaces()
    all_classes = set(ontology_store["_superclasses"].keys()) | set(ontology_store["_subclasses"].keys())
    result = []
    for uri in sorted(all_classes):
        if uri in _META_URIS:
            continue
        d = uri_to_dict(uri, g, ns)
        # Attach direct parents so frontend can show hierarchy hints
        direct_parents = [
            p for p in ontology_store["_superclasses"].get(uri, set())
            if p not in _META_URIS
        ]
        d["parents"] = sorted(direct_parents)
        result.append(d)
    return result


def get_ancestor_uris(uri: str) -> Set[str]:
    """Return uri itself plus all transitive superclasses."""
    return {uri} | ontology_store["_superclasses"].get(uri, set())


def get_descendant_uris(uri: str) -> Set[str]:
    """Return uri itself plus all transitive subclasses."""
    return {uri} | ontology_store["_subclasses"].get(uri, set())


def get_properties_for_subject(subject_uri: str, widening: bool = False, inheritance: bool = True) -> List[dict]:
    """
    Return all properties whose domain is compatible with subject_uri.

    A property P is compatible if ANY of the following is true:
      1. subject_uri is directly in domain(P)
      2. An ancestor of subject_uri is in domain(P)   ← inheritance (only if inheritance=True)
      3. A descendant of subject_uri is in domain(P)  ← widening (only if widening=True)
      4. P has no domain restriction at all            ← applies to everything

    Standard RDFS semantics = 1 + 2 + 4.
    Widening adds 3: properties defined on subclasses are also offered
    for the superclass, marked with "widened_from".
    When inheritance=False, path 2 is disabled: only direct and domain-free
    properties are shown (plus widened ones if widening is on).
    """
    g   = ontology_store["merged"]
    ns  = get_namespaces()
    pd  = ontology_store["_prop_domains"]
    ap  = ontology_store["_all_props"]

    # All URIs that "are or represent" the subject in the hierarchy
    subject_ancestors = get_ancestor_uris(subject_uri)
    subject_ancestors_only = subject_ancestors - {subject_uri}  # strict ancestors (parents)
    subject_descendants = get_descendant_uris(subject_uri) - {subject_uri} if widening else set()

    props: Set[str] = set()
    widened_props: Set[str] = set()   # track which ones came via widening
    inherited_only_props: Set[str] = set()  # track which ones came ONLY via inheritance

    for p_uri in ap:
        domains = pd.get(p_uri, set())
        if not domains:
            # No domain restriction → property applies to everything
            props.add(p_uri)
        elif subject_uri in domains:
            # Direct match: subject_uri is explicitly in domain(P)
            props.add(p_uri)
        elif domains & subject_ancestors_only:
            # Inherited: an ancestor (parent) of subject is in the domain
            props.add(p_uri)
            if not (domains & {subject_uri}):
                inherited_only_props.add(p_uri)
        elif widening and (domains & subject_descendants):
            # Widening: a descendant of subject is in the domain
            props.add(p_uri)
            widened_props.add(p_uri)

    # If inheritance is disabled, remove properties that were ONLY found via ancestors
    if not inheritance:
        props -= inherited_only_props

    result = []
    for uri in sorted(props):
        d = uri_to_dict(uri, g, ns)
        direct_domains = pd.get(uri, set())

        # Annotate which ancestor(s) provided the property (for UI tooltip)
        inherited_from = []
        if subject_uri not in direct_domains and uri not in widened_props:
            inherited_from = sorted(direct_domains & subject_ancestors - {subject_uri})
        d["inherited_from"] = inherited_from

        # Annotate widening source
        widened_from = []
        if uri in widened_props:
            widened_from = sorted(direct_domains & subject_descendants)
        d["widened_from"] = widened_from

        result.append(d)
    return result


def get_range_for_property(subject_uri: str, property_uri: str) -> List[dict]:
    """
    Return valid range classes for property_uri when used with subject_uri.

    Range inference:
      - Return the direct rdfs:range class(es) of the property
      - PLUS all subclasses of each range class (a subclass is also a valid range)
      - If no range is declared, return nothing (don't guess)
    """
    g   = ontology_store["merged"]
    ns  = get_namespaces()
    pr  = ontology_store["_prop_ranges"]

    direct_ranges = pr.get(property_uri, set())
    if not direct_ranges:
        return []

    # Expand to include all subclasses of each declared range
    expanded: Set[str] = set()
    for r_uri in direct_ranges:
        expanded.add(r_uri)
        expanded |= get_descendant_uris(r_uri)

    # Filter out meta-classes
    expanded -= _META_URIS

    result = []
    for uri in sorted(expanded):
        d = uri_to_dict(uri, g, ns)
        d["is_direct_range"] = uri in direct_ranges
        result.append(d)

    # Sort: direct ranges first, then subclasses alphabetically
    result.sort(key=lambda x: (not x["is_direct_range"], x["label"]))
    return result


def get_class_hierarchy() -> dict:
    """
    Build a tree-like structure for the frontend hierarchy view.
    Returns a dict: uri -> { label, uri, parents: [uri,...], children: [uri,...] }
    """
    g  = ontology_store["merged"]
    ns = get_namespaces()
    sc = ontology_store["_superclasses"]
    sb = ontology_store["_subclasses"]

    result = {}
    all_uris = set(sc.keys()) | set(sb.keys())
    for uri in all_uris:
        if uri in _META_URIS:
            continue
        d = uri_to_dict(uri, g, ns)
        # Only direct parents/children (not transitive)
        direct_parents = []
        for p in sc.get(uri, set()):
            if p not in _META_URIS:
                # Check it's a *direct* parent: no shorter path
                # Approximation: direct = in superclasses but not reachable via another superclass
                other_ancestors = set()
                for q in sc.get(uri, set()):
                    if q != p:
                        other_ancestors |= sc.get(q, set())
                if p not in other_ancestors:
                    direct_parents.append(p)
        direct_children = []
        for c in sb.get(uri, set()):
            if c not in _META_URIS:
                other_descendants = set()
                for q in sb.get(uri, set()):
                    if q != c:
                        other_descendants |= sb.get(q, set())
                if c not in other_descendants:
                    direct_children.append(c)
        d["parents"]  = sorted(direct_parents)
        d["children"] = sorted(direct_children)
        result[uri] = d

    return result


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    sc_count = len(ontology_store["_superclasses"])
    prop_count = len(ontology_store["_all_props"])
    return {
        "status": "ok",
        "rdflib": RDFLIB_AVAILABLE,
        "classes_indexed": sc_count,
        "properties_indexed": prop_count,
    }


@app.post("/ontology/upload")
async def upload_ontology(files: List[UploadFile] = File(...)):
    if not RDFLIB_AVAILABLE:
        raise HTTPException(500, "rdflib not installed. Run: pip install rdflib")

    loaded, errors = [], []
    FORMAT_CANDIDATES = ["turtle", "xml", "n3", "nt", "json-ld"]

    for file in files:
        content = await file.read()
        fn = file.filename or "unknown"
        # Guess primary format from extension
        ext = fn.rsplit(".", 1)[-1].lower()
        fmt_order = {
            "ttl": ["turtle", "n3", "xml"],
            "rdf": ["xml", "turtle"],
            "owl": ["xml", "turtle"],
            "xml": ["xml", "turtle"],
            "nt":  ["nt", "turtle"],
            "n3":  ["n3", "turtle"],
        }.get(ext, FORMAT_CANDIDATES)

        parsed = False
        for fmt in fmt_order:
            try:
                g = Graph()
                g.parse(data=content.decode("utf-8", errors="replace"), format=fmt)
                ontology_store["graphs"][fn] = g
                loaded.append(fn)
                parsed = True
                break
            except Exception:
                continue
        if not parsed:
            errors.append({"file": fn, "error": "Could not parse with any known format"})

    rebuild_merged()

    return {
        "loaded": loaded,
        "errors": errors,
        "total_triples": len(ontology_store["merged"]) if ontology_store["merged"] else 0,
        "ontologies": list(ontology_store["graphs"].keys()),
        "classes_indexed": len(ontology_store["_superclasses"]),
        "properties_indexed": len(ontology_store["_all_props"]),
    }


@app.get("/ontology/list")
def list_ontologies():
    return {
        "ontologies": list(ontology_store["graphs"].keys()),
        "total_triples": len(ontology_store["merged"]) if ontology_store["merged"] else 0,
    }


@app.delete("/ontology/{filename}")
def delete_ontology(filename: str):
    if filename in ontology_store["graphs"]:
        del ontology_store["graphs"][filename]
        rebuild_merged()
        return {"deleted": filename}
    raise HTTPException(404, f"Ontology '{filename}' not found")


@app.get("/ontology/classes")
def get_classes(search: Optional[str] = None):
    if not ontology_store["merged"]:
        return {"classes": []}
    classes = get_all_classes_dicts()
    if search:
        sl = search.lower()
        classes = [
            c for c in classes
            if sl in c["label"].lower()
            or (c["rdfs_label"] and sl in c["rdfs_label"].lower())
        ]
    return {"classes": classes}


@app.get("/ontology/properties")
def get_properties(subject_uri: str, search: Optional[str] = None, widening: bool = False, inheritance: bool = True):
    if not ontology_store["merged"]:
        return {"properties": []}
    props = get_properties_for_subject(subject_uri, widening=widening, inheritance=inheritance)
    if search:
        sl = search.lower()
        props = [
            p for p in props
            if sl in p["label"].lower()
            or (p["rdfs_label"] and sl in p["rdfs_label"].lower())
        ]
    return {"properties": props}


@app.get("/ontology/range")
def get_range(subject_uri: str, property_uri: str):
    if not ontology_store["merged"]:
        return {"ranges": []}
    ranges = get_range_for_property(subject_uri, property_uri)
    return {"ranges": ranges}


@app.get("/ontology/hierarchy")
def get_hierarchy():
    """
    Full class hierarchy as a flat dict for the frontend tree view.
    Each entry has: uri, label, rdfs_label, parents[], children[]
    """
    if not ontology_store["merged"]:
        return {"hierarchy": {}}
    return {"hierarchy": get_class_hierarchy()}


@app.get("/ontology/superclasses")
def get_superclasses(uri: str):
    """All transitive superclasses of a given URI."""
    ancestors = sorted(get_ancestor_uris(uri) - {uri} - _META_URIS)
    ns  = get_namespaces()
    g   = ontology_store["merged"]
    return {"superclasses": [uri_to_dict(u, g, ns) for u in ancestors]}


@app.get("/ontology/subclasses")
def get_subclasses(uri: str):
    """All transitive subclasses of a given URI."""
    descendants = sorted(get_descendant_uris(uri) - {uri} - _META_URIS)
    ns = get_namespaces()
    g  = ontology_store["merged"]
    return {"subclasses": [uri_to_dict(u, g, ns) for u in descendants]}


@app.get("/ontology/namespaces")
def list_namespaces():
    return {"namespaces": get_namespaces()}


# pydantic models for the export endpoints below
from pydantic import BaseModel


# ─── RDF/XML Export (local, no external tools needed) ────────────────────────

class RdfExportRequest(BaseModel):
    uri_tsv: str          # TSV content for URI triples
    literal_tsv: str = "" # TSV content for literal triples
    format: str = "xml"   # xml, turtle, n3, nt, jsonld
    # Language of the plain `domain_label` / `range_label` columns. Defaults to
    # "en" so a caller that predates language support — a replayed TSV, a
    # script — gets exactly the output it always got. An empty string means
    # "write the label without a language tag".
    primary_lang: str = "en"
    # Languages carried in the additional `<column>@<tag>` columns.
    additional_langs: list = []


def _label_literals(row: dict, base: str, primary_lang: str, additional_langs: list) -> list:
    """Every language variant of one label column, as (text, lang) pairs.

    The plain column holds the primary language, `<base>@<tag>` the others —
    which is why a single-language export produces exactly the same triples it
    did before this existed.
    """
    out = []
    main = (row.get(base, "") or "").strip()
    if main:
        out.append((main, primary_lang or None))
    for lang in (additional_langs or []):
        text = (row.get(f"{base}@{lang}", "") or "").strip()
        if text:
            out.append((text, lang))
    return out


def _safe_uri(val: str) -> str:
    """Ensure a value is a valid URI string; strip whitespace."""
    return val.strip() if val else ""


def _parse_tsv(tsv_content: str) -> list:
    """Parse TSV content into list of dicts."""
    if not tsv_content or not tsv_content.strip():
        return []
    lines = tsv_content.strip().split('\n')
    if len(lines) < 2:
        return []
    headers = lines[0].split('\t')
    rows = []
    for line in lines[1:]:
        cols = line.split('\t')
        row = {}
        for i, h in enumerate(headers):
            row[h.strip()] = cols[i].strip() if i < len(cols) else ""
        rows.append(row)
    return rows



@app.post("/pipeline/rdf-export")
def export_rdf(req: RdfExportRequest):
    """
    Generate RDF from URI-expanded TSV data using rdflib.
    Supports Named Graphs via ConjunctiveGraph.
    Returns debug info to help diagnose issues.
    """
    if not RDFLIB_AVAILABLE:
        raise HTTPException(500, "rdflib nicht verfügbar")

    from rdflib import ConjunctiveGraph, Graph as RdfGraph, URIRef, Literal, Namespace, BNode
    from rdflib.namespace import RDF, RDFS, XSD

    dataset = ConjunctiveGraph()

    CRM = Namespace("http://www.cidoc-crm.org/cidoc-crm/")
    dataset.bind("crm", CRM)
    dataset.bind("rdfs", RDFS)
    dataset.bind("rdf", RDF)
    dataset.bind("xsd", XSD)

    _graph_cache = {}
    DEFAULT_GRAPH_ID = URIRef("urn:x-default:graph")

    def _is_absolute_iri(val: str) -> bool:
        if not val:
            return False
        return "://" in val or val.startswith("urn:")

    def _to_uriref(val: str):
        if not val or not val.strip():
            return None
        v = val.strip()
        if _is_absolute_iri(v):
            return URIRef(v)
        return None

    def _to_uriref_lenient(val: str):
        """Like _to_uriref but also accepts prefixed names, converting them
        to absolute URIs using known namespace prefixes or a base URI.
        This is needed for Named Graph identifiers and dot-one properties
        that might not have been expanded by the frontend."""
        if not val or not val.strip():
            return None
        v = val.strip()
        if _is_absolute_iri(v):
            return URIRef(v)
        # Prefixed name like "crm:P2_has_type" — try known namespaces first
        if ":" in v and not v.startswith("_:"):
            prefix, _, local = v.partition(":")
            # Check if any bound namespace matches this prefix
            for ns_prefix, ns_uri in dataset.namespaces():
                if ns_prefix == prefix:
                    return URIRef(str(ns_uri) + local)
            # Known CRM namespaces as fallback
            known = {
                "crm": "http://www.cidoc-crm.org/cidoc-crm/",
                "crmarchaeo": "http://www.cidoc-crm.org/extensions/crmarchaeo/",
                "crmsci": "http://www.cidoc-crm.org/extensions/crmsci/",
                "lrmoo": "http://www.cidoc-crm.org/extensions/lrmoo/",
                "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
                "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
                "xsd": "http://www.w3.org/2001/XMLSchema#",
                "owl": "http://www.w3.org/2002/07/owl#",
            }
            if prefix in known:
                return URIRef(known[prefix] + local)
            # Generic fallback
            return URIRef(f"http://example.com/base/{prefix}/{local}")
        return None

    def _get_graph(i4_uri: str):
        if not i4_uri or not i4_uri.strip():
            if "__default__" not in _graph_cache:
                _graph_cache["__default__"] = dataset.get_context(DEFAULT_GRAPH_ID)
            return _graph_cache["__default__"]
        i4 = i4_uri.strip()
        # Try absolute IRI first, then lenient conversion
        if _is_absolute_iri(i4):
            graph_uri = URIRef(i4)
        else:
            ref = _to_uriref_lenient(i4)
            if ref:
                graph_uri = ref
            else:
                if "__default__" not in _graph_cache:
                    _graph_cache["__default__"] = dataset.get_context(DEFAULT_GRAPH_ID)
                return _graph_cache["__default__"]
        key = str(graph_uri)
        if key not in _graph_cache:
            _graph_cache[key] = dataset.get_context(graph_uri)
        return _graph_cache[key]

    skipped = []
    added = 0
    rdfstar_annotations = []  # Collect RDF-star triples for manual serialization

    def _add(graph, s, p, o):
        nonlocal added
        try:
            graph.add((s, p, o))
            added += 1
        except Exception as e:
            skipped.append(f"add-error: {e}")

    # Parse TSV
    uri_rows = _parse_tsv(req.uri_tsv)
    lit_rows = _parse_tsv(req.literal_tsv)

    debug_info = {
        "uri_tsv_bytes": len(req.uri_tsv) if req.uri_tsv else 0,
        "literal_tsv_bytes": len(req.literal_tsv) if req.literal_tsv else 0,
        "uri_rows_parsed": len(uri_rows),
        "literal_rows_parsed": len(lit_rows),
        "first_uri_row": uri_rows[0] if uri_rows else None,
    }

    # Process URI triples
    for row in uri_rows:
        domain_ref = _to_uriref(row.get("id_of_domain_uri", ""))
        class_ref = _to_uriref(row.get("class_of_domain_uri", ""))
        prop_ref = _to_uriref(row.get("property_uri", ""))
        range_ref = _to_uriref(row.get("id_of_the_range_uri", ""))
        range_class_ref = _to_uriref(row.get("class_of_the_range_uri", ""))
        dot1_ref = _to_uriref_lenient(row.get("dot_one_uri", ""))
        dot1_target_ref = _to_uriref_lenient(row.get("dot_one_target_uri", ""))
        i4_uri = (row.get("i4_uri", "") or "").strip()
        domain_label = (row.get("domain_label", "") or "").strip()
        range_label = (row.get("range_label", "") or "").strip()
        p3_note = (row.get("p3_has_note", "") or "").strip()

        if not domain_ref:
            val = row.get("id_of_domain_uri", "")
            if val and val.strip():
                skipped.append(f"domain not absolute IRI: {val}")
            continue

        g = _get_graph(i4_uri)

        if class_ref:
            _add(g, domain_ref, RDF.type, class_ref)
        for text, lang in _label_literals(row, "domain_label", req.primary_lang, req.additional_langs):
            _add(g, domain_ref, RDFS.label, Literal(text, lang=lang))
        if p3_note:
            _add(g, domain_ref, CRM.P3_has_note, Literal(p3_note))
        if range_ref and range_class_ref:
            _add(g, range_ref, RDF.type, range_class_ref)
        if range_ref:
            for text, lang in _label_literals(row, "range_label", req.primary_lang, req.additional_langs):
                _add(g, range_ref, RDFS.label, Literal(text, lang=lang))
        if prop_ref and range_ref:
            _add(g, domain_ref, prop_ref, range_ref)
        elif prop_ref and not range_ref and range_label:
            # The range didn't resolve to a valid URI -- this is what a
            # "Literal (no prefix)" node produces when its ID column isn't
            # meant to be a resource URI at all (e.g. a free-text note or
            # description mapped with its own ID+Label columns, as CIDOC's
            # P3_has_note is typically used). Rather than silently dropping
            # the property triple, fall back to the range's label text as
            # a plain literal object -- this is what was actually intended.
            _add(g, domain_ref, prop_ref, Literal(range_label))
        if dot1_ref and dot1_target_ref and prop_ref and range_ref:
            # Collect RDF-star annotation for manual serialization
            rdfstar_annotations.append({
                's': str(domain_ref), 'p': str(prop_ref), 'o': str(range_ref),
                'dot_p': str(dot1_ref), 'dot_o': str(dot1_target_ref),
                'graph': i4_uri,
            })
            # Also add as BNode reification so rdflib's graph has the data
            reif = BNode()
            _add(g, reif, RDF.type, RDF.Statement)
            _add(g, reif, RDF.subject, domain_ref)
            _add(g, reif, RDF.predicate, prop_ref)
            _add(g, reif, RDF.object, range_ref)
            _add(g, reif, dot1_ref, dot1_target_ref)

    # Process literal triples
    for row in lit_rows:
        domain_ref = _to_uriref(row.get("id_of_domain_uri", ""))
        class_ref = _to_uriref(row.get("class_of_domain_uri", ""))
        prop_ref = _to_uriref(row.get("property_uri", ""))
        range_value = (row.get("id_of_the_range_uri", "") or "").strip()
        range_dt_ref = _to_uriref(row.get("class_of_the_range_uri", ""))
        i4_uri = (row.get("i4_uri", "") or "").strip()
        domain_label = (row.get("domain_label", "") or "").strip()
        p3_note = (row.get("p3_has_note", "") or "").strip()

        if not domain_ref:
            continue

        g = _get_graph(i4_uri)

        if class_ref:
            _add(g, domain_ref, RDF.type, class_ref)
        for text, lang in _label_literals(row, "domain_label", req.primary_lang, req.additional_langs):
            _add(g, domain_ref, RDFS.label, Literal(text, lang=lang))
        if p3_note:
            _add(g, domain_ref, CRM.P3_has_note, Literal(p3_note))
        if prop_ref and range_value:
            if range_dt_ref:
                _add(g, domain_ref, prop_ref, Literal(range_value, datatype=range_dt_ref))
            else:
                _add(g, domain_ref, prop_ref, Literal(range_value))

    # ── Post-process: replace BNode reification with RDF-star syntax ─────────
    def _uri_to_prefixed(uri_str, ns_map):
        """Convert absolute URI to prefixed form if possible."""
        for pfx, ns_uri in sorted(ns_map.items(), key=lambda x: -len(str(x[1]))):
            ns = str(ns_uri)
            if uri_str.startswith(ns):
                local = uri_str[len(ns):]
                if local and "/" not in local and "#" not in local:
                    return f"{pfx}:{local}"
        return f"<{uri_str}>"

    def _uri_to_full(uri_str):
        """Always return full <URI> form."""
        if uri_str.startswith("<"):
            return uri_str
        return f"<{uri_str}>"

    def _remove_bnode_reification(rdf_text):
        """Remove BNode-based RDF reification blocks from serialized output."""
        import re
        # rdflib serializes BNode reification in multiple formats:
        # Turtle/TriG: _:Nxxx a rdf:Statement ;\n    rdf:subject ... ;\n    ... .
        # N-Triples/N-Quads: multiple lines starting with _:Nxxx
        
        # Collect BNode IDs that are reification nodes
        reif_bnodes = set()
        for line in rdf_text.split('\n'):
            stripped = line.strip()
            # Match: _:Nxxx a rdf:Statement  OR  _:Nxxx <...22-rdf-syntax-ns#type> <...Statement>
            if 'Statement' in stripped and stripped.startswith('_:'):
                bnode_id = stripped.split()[0]
                reif_bnodes.add(bnode_id)
            # Turtle compact: _:Nxxx a rdf:Statement ;
            if ' a rdf:Statement' in stripped and stripped.startswith('_:'):
                bnode_id = stripped.split()[0]
                reif_bnodes.add(bnode_id)

        if not reif_bnodes:
            return rdf_text

        # Remove all lines/blocks referencing these BNode IDs
        result_lines = []
        skip_block = False
        for line in rdf_text.split('\n'):
            stripped = line.strip()
            # Check if this line starts a BNode reification block
            starts_with_reif = False
            for bn in reif_bnodes:
                if stripped.startswith(bn + ' ') or stripped.startswith(bn + '\t'):
                    starts_with_reif = True
                    break
            if starts_with_reif:
                skip_block = True
            if skip_block:
                # In Turtle/TriG, block ends with a line containing '.'
                if stripped.endswith('.'):
                    skip_block = False
                continue
            result_lines.append(line)
        return '\n'.join(result_lines)

    def _inject_rdfstar(rdf_text, annotations, ns_map, rdf_format):
        """Remove BNode reification and inject proper RDF-star syntax."""
        if not annotations:
            return rdf_text

        cleaned = _remove_bnode_reification(rdf_text)

        if rdf_format in ("nt", "nquads"):
            # N-Triples / N-Quads: must use full URIs, no prefixed names
            star_lines = []
            for ann in annotations:
                s = _uri_to_full(ann['s'])
                p = _uri_to_full(ann['p'])
                o = _uri_to_full(ann['o'])
                dp = _uri_to_full(ann['dot_p'])
                do_val = _uri_to_full(ann['dot_o'])
                if rdf_format == "nquads" and ann.get('graph'):
                    g_uri = _uri_to_full(ann['graph'])
                    star_lines.append(f"<< {s} {p} {o} >> {dp} {do_val} {g_uri} .")
                else:
                    star_lines.append(f"<< {s} {p} {o} >> {dp} {do_val} .")
            return cleaned.rstrip() + "\n" + "\n".join(star_lines) + "\n"

        elif rdf_format == "trig":
            # TriG: annotations must go inside their graph block
            # or in the default graph. Use prefixed names.
            # Group annotations by graph
            by_graph = {}
            for ann in annotations:
                g_key = ann.get('graph', '') or '__default__'
                by_graph.setdefault(g_key, []).append(ann)

            extra_blocks = []
            for g_key, anns in by_graph.items():
                lines_for_graph = []
                for ann in anns:
                    s = _uri_to_prefixed(ann['s'], ns_map)
                    p = _uri_to_prefixed(ann['p'], ns_map)
                    o = _uri_to_prefixed(ann['o'], ns_map)
                    dp = _uri_to_prefixed(ann['dot_p'], ns_map)
                    do_val = _uri_to_prefixed(ann['dot_o'], ns_map)
                    lines_for_graph.append(f"  << {s} {p} {o} >> {dp} {do_val} .")

                if g_key == '__default__':
                    # Append to default graph (no wrapper)
                    extra_blocks.append("\n# RDF-star annotations (dot-one properties)")
                    extra_blocks.extend(lines_for_graph)
                else:
                    g_uri = _uri_to_full(g_key) if not g_key.startswith('<') else g_key
                    extra_blocks.append(f"\n# RDF-star annotations for graph {g_key}")
                    extra_blocks.append(f"{g_uri} {{")
                    extra_blocks.extend(lines_for_graph)
                    extra_blocks.append("}")

            return cleaned.rstrip() + "\n" + "\n".join(extra_blocks) + "\n"

        else:
            # Turtle, N3: use prefixed names
            star_lines = ["\n# RDF-star annotations (dot-one properties)"]
            for ann in annotations:
                s = _uri_to_prefixed(ann['s'], ns_map)
                p = _uri_to_prefixed(ann['p'], ns_map)
                o = _uri_to_prefixed(ann['o'], ns_map)
                dp = _uri_to_prefixed(ann['dot_p'], ns_map)
                do_val = _uri_to_prefixed(ann['dot_o'], ns_map)
                star_lines.append(f"<< {s} {p} {o} >> {dp} {do_val} .")
            return cleaned.rstrip() + "\n" + "\n".join(star_lines) + "\n"

    # Build namespace map for prefix resolution
    _ns_map = {}
    for pfx, ns_uri in dataset.namespaces():
        _ns_map[pfx] = ns_uri

    # Serialize
    fmt_map = {
        "xml": "xml", "turtle": "turtle", "ttl": "turtle",
        "n3": "n3", "nt": "nt", "ntriples": "nt",
        "nq": "nquads", "nquads": "nquads",
        "trig": "trig",
        "jsonld": "json-ld", "json-ld": "json-ld",
    }
    rdf_format = fmt_map.get(req.format.lower().strip(), "xml")

    if rdf_format in ("xml", "turtle", "n3", "nt"):
        flat = RdfGraph()
        for prefix, ns in dataset.namespaces():
            flat.bind(prefix, ns)
        for s, p, o, _ctx in dataset.quads((None, None, None, None)):
            flat.add((s, p, o))
        try:
            rdf_output = flat.serialize(format=rdf_format)
            if isinstance(rdf_output, bytes):
                rdf_output = rdf_output.decode("utf-8")
        except Exception as e:
            raise HTTPException(500, f"Serialisierung fehlgeschlagen: {e}")
    else:
        try:
            rdf_output = dataset.serialize(format=rdf_format)
            if isinstance(rdf_output, bytes):
                rdf_output = rdf_output.decode("utf-8")
        except Exception as e:
            raise HTTPException(500, f"Serialisierung fehlgeschlagen: {e}")

    ext_map = {
        "xml": ".rdf", "turtle": ".ttl", "n3": ".n3", "nt": ".nt",
        "nquads": ".nq", "trig": ".trig", "json-ld": ".jsonld",
    }

    # Inject RDF-star syntax for formats that support it
    if rdfstar_annotations and rdf_format in ("turtle", "trig", "nt", "nquads", "n3"):
        rdf_output = _inject_rdfstar(rdf_output, rdfstar_annotations, _ns_map, rdf_format)

    mime_map = {
        "xml": "application/rdf+xml", "turtle": "text/turtle",
        "n3": "text/n3", "nt": "application/n-triples",
        "nquads": "application/n-quads", "trig": "application/trig",
        "json-ld": "application/ld+json",
    }

    return {
        "rdf": rdf_output,
        "format": rdf_format,
        "extension": ext_map.get(rdf_format, ".rdf"),
        "mime_type": mime_map.get(rdf_format, "application/rdf+xml"),
        "triple_count": added,
        "skipped_uris": sorted(set(skipped))[:30],
        "debug": debug_info,
    }


# ─── Graph Explorer JSON Export ──────────────────────────────────────────────
#
# Converts the TSV-based mapping data into the internal graph JSON format
# consumed by graph-explorer.html.
#
# Internal node model:
#   { l: label, t: type_key, a: { attr: val, ... }, o: { edge: [nodeId,...] }, i: { edge: [nodeId,...] } }
#
# Top-level graph JSON:
#   { meta, nodes, node_types, edge_types, schema }
#
# The `schema` block carries all display config so the Explorer never needs
# hardcoded type names or colors.

class GraphExplorerRequest(BaseModel):
    uri_tsv: str
    literal_tsv: str = ""
    title: str = "RDF Graph"
    # Schema hints from the frontend (derived from the canvas nodes/edges)
    type_colors: dict = {}   # { typeUri: hexColor }
    type_labels: dict = {}   # { typeUri: humanLabel }
    edge_labels: dict = {}   # { edgeUri: humanLabel }
    # Label languages. The primary one fills the existing single-value fields
    # (`l`, `typeLabels`, `edgeLabels`); the additional ones fill the parallel
    # *I18n maps. An Explorer that does not know about them reads exactly what
    # it always read.
    primary_lang: str = "en"
    additional_langs: list = []


# CIDOC CRM anchor colors (same as frontend cidocColors.js)
_CRM_COLORS = {
    "e18": "#c78e66", "e2": "#82ddff", "e39": "#ffbdca",
    "e41": "#fef3ba", "e52": "#86bcc8", "e53": "#94cc7d",
    "e54": "#b8b8b8", "e55": "#fab565", "e59": "#f0f0f0",
    "e28": "#fddc34", "e92": "#cc80ff",
}
_PALETTE = [
    "#c78e66","#82ddff","#ffbdca","#fef3ba","#86bcc8",
    "#94cc7d","#b8b8b8","#fab565","#fddc34","#cc80ff",
    "#a8e6cf","#ff8b94","#ffd3b6","#dcedc1","#a8d8ea",
    "#aa96da","#fcbad3","#ffffd2","#c4a03a","#7ec8e3",
]

def _color_for_type(uri: str, idx: int, type_colors: dict) -> str:
    """Return a color for a type URI: use provided map, then CRM anchor, then palette."""
    if uri in type_colors:
        return type_colors[uri]
    # Try CRM anchor by local name prefix
    local = uri.split("#")[-1].split("/")[-1].lower()
    for anchor, color in _CRM_COLORS.items():
        # Match the anchor only at a token boundary. A plain startswith()
        # lets the "e2" anchor (E2_Temporal_Entity) swallow E21/E22/E27/E28…,
        # colouring e.g. E27_Site (a Place) as a Temporal Entity. Require the
        # character after the anchor to be a non-alphanumeric separator (or
        # end of string) so "e2" no longer matches "e27_site".
        if local == anchor or (local.startswith(anchor) and not local[len(anchor):len(anchor) + 1].isalnum()):
            return color
    return _PALETTE[idx % len(_PALETTE)]


def _humanise(uri: str) -> str:
    """Convert a URI or prefixed name to a readable label."""
    local = uri.split("#")[-1].split("/")[-1]
    # Remove leading E-number pattern for CIDOC classes
    return local.replace("_", " ").strip()


def _get_local(uri: str) -> str:
    return uri.split("#")[-1].split("/")[-1]


def _slugify(text: str) -> str:
    """Stable, dict-key-safe form of a free-text label (only used to build
    the synthetic Explorer type key, never shown to the user)."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower()).strip("_")
    return s or "x"


# ─── Dot-One (RDF-Star) qualifier handling for Graph Explorer export ────────
#
# A dot-one annotation qualifies a base edge with a value (e.g. CRMarchaeo's
# AP11.1_has_type on AP11_has_physical_relation_to: "above" / "below" /
# "same time" / "equals"). The base property is normally used unchanged in
# both directions (e.g. AP11 is typically symmetric in the ontology), so
# directionality lives entirely in the qualifier value, not in an
# owl:inverseOf property pair. We therefore invert the *value* for the
# incoming adjacency, not the property.
#
# Qualifier values often come from a URI's local name (e.g.
# .../oeai/ueber), which is plain ASCII -- German umlauts get typed as
# their transliteration (ü -> ue) rather than the accented character.
# Grouping/inversion must therefore compare a *folded* canonical form
# (ue/oe/ae/ss) so "über" and "ueber" are recognised as the same value
# instead of silently splitting into two unrelated edge-type groups.
_UMLAUT_FOLD = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue",
    "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss",
})

# canonical (folded) form -> { inverse: canonical form of the opposite value,
# label: preferred display spelling }. Only the common CIDOC/CRMarchaeo
# physical-relation and temporal-relation vocabulary is known here; unknown
# values fall back to being shown unchanged in both directions (safe
# default, no guessing).
_DOT_ONE_VOCAB = {
    "ueber": {"inverse": "unter", "label": "über"},
    "unter": {"inverse": "ueber", "label": "unter"},
    "above": {"inverse": "below", "label": "above"},
    "below": {"inverse": "above", "label": "below"},
    "over":  {"inverse": "under", "label": "over"},
    "under": {"inverse": "over",  "label": "under"},
    "oben":  {"inverse": "unten", "label": "oben"},
    "unten": {"inverse": "oben",  "label": "unten"},
    "gleichzeitig":      {"inverse": "gleichzeitig", "label": "gleichzeitig"},
    "zeitgleich":        {"inverse": "zeitgleich", "label": "zeitgleich"},
    "same time":         {"inverse": "same time", "label": "same time"},
    "same-time":         {"inverse": "same-time", "label": "same time"},
    "contemporary with": {"inverse": "contemporary with", "label": "contemporary with"},
    "entspricht":        {"inverse": "entspricht", "label": "entspricht"},
    "equals":            {"inverse": "equals", "label": "equals"},
    "same as":           {"inverse": "same as", "label": "same as"},
    "corresponds to":    {"inverse": "corresponds to", "label": "corresponds to"},
}


def _dot_one_raw_text(value: str) -> str:
    """Extract plain text from a raw dot-one target cell (literal or URI)."""
    v = value.strip()
    if "://" in v:
        return _humanise(v)
    return v.replace("_", " ")


def _dot_one_canon(text: str) -> str:
    """Fold umlauts + lowercase -- the key used for matching/grouping so
    spelling variants (über/ueber) merge into a single edge-type group.

    Qualifier URIs are often minted as "<column prefix>_<value>" (e.g.
    .../oeai/Relationstyp_above -> "relationstyp above"). When the full text
    is not known vocabulary but a trailing part of it is, that trailing part
    is used, so the value is still recognised and correctly inverted
    (above/below) instead of the same unknown word being shown in both
    directions."""
    canon = text.strip().lower().translate(_UMLAUT_FOLD)
    if canon in _DOT_ONE_VOCAB:
        return canon
    words = canon.split()
    for i in range(1, len(words)):
        tail = " ".join(words[i:])
        if tail in _DOT_ONE_VOCAB:
            return tail
    return canon


def _dot_one_label(text: str) -> str:
    """Preferred display spelling for a raw qualifier value. Known
    vocabulary always renders the same way regardless of which spelling
    variant appeared in the source data; unknown values pass through as-is."""
    entry = _DOT_ONE_VOCAB.get(_dot_one_canon(text))
    return entry["label"] if entry else text


def _dot_one_inverse_label(text: str) -> str:
    entry = _DOT_ONE_VOCAB.get(_dot_one_canon(text))
    if not entry:
        return text  # unknown vocabulary -> unchanged, no guessing
    inv_entry = _DOT_ONE_VOCAB.get(entry["inverse"])
    return inv_entry["label"] if inv_entry else entry["inverse"]


def _dot_one_edge_key(prop_uri: str, text: str) -> str:
    """Synthetic (non-URI) edge-type key that splits a base property into
    one group per dot-one qualifier value, keyed by the CANONICAL form so
    'über' and 'ueber' land in the same group, e.g.
    AP11_has_physical_relation_to + 'über'/'ueber' -> '<uri>#dot1:ueber'.
    Not a real ontology URI -- used only as a dict key in the Graph-JSON
    `o`/`i`/`edge_types` maps."""
    return f"{prop_uri}#dot1:{_dot_one_canon(text)}"


@app.post("/pipeline/graph-explorer-json")
def export_graph_explorer_json(req: GraphExplorerRequest):
    """
    Convert TSV mapping data into the Graph Explorer JSON format.
    Also returns a schema block with type colors/labels derived from the
    ontology model (superclasses looked up from the loaded ontology).
    """
    uri_rows  = _parse_tsv(req.uri_tsv)
    lit_rows  = _parse_tsv(req.literal_tsv)

    g = ontology_store.get("merged")

    def resolve_edge_label(e_uri: str) -> str:
        """Prefer an explicit frontend-provided label, then rdfs:label from
        the loaded ontology, then a humanised local name."""
        if e_uri in req.edge_labels:
            return req.edge_labels[e_uri]
        if g:
            from rdflib import URIRef as RDFURIRef
            rdfs_lbl = _preferred_literal(g, RDFURIRef(e_uri), RDFS.label)
            if rdfs_lbl:
                return str(rdfs_lbl)
        return _humanise(e_uri)

    nodes: dict = {}   # nodeId -> node dict
    edge_counts: dict = {}

    # Graph-Explorer-only display name override, set per canvas node in the
    # Studio ("Explorer-Name" field). Lets identically-classed nodes used
    # for different purposes (e.g. three separate E55_Type nodes used for
    # relation type / material / SE-Art) show up as distinct, separately
    # labelled/counted types in the Explorer -- without touching the real
    # CIDOC class, which the RDF export continues to use unchanged.
    type_base_class: dict = {}      # synthetic type key -> original CIDOC class URI (for color lookup)
    explorer_type_labels: dict = {} # synthetic type key -> custom label
    # synthetic type key -> { lang: custom label }. The type KEY still derives
    # from the primary-language name only, so switching the display language in
    # the Explorer renames the groups without regrouping the nodes.
    explorer_type_labels_i18n: dict = {}

    add_langs = [l for l in (req.additional_langs or []) if l and l != req.primary_lang]

    def _resolve_type_key(class_uri: str, explorer_label: str, explorer_label_i18n: dict = None) -> str:
        if not class_uri or not explorer_label:
            return class_uri
        key = f"{class_uri}#as:{_slugify(explorer_label)}"
        type_base_class[key] = class_uri
        explorer_type_labels[key] = explorer_label
        for lang, text in (explorer_label_i18n or {}).items():
            if text:
                explorer_type_labels_i18n.setdefault(lang, {})[key] = text
        return key

    def ensure_node(uri: str, class_uri: str = "", label: str = "", explorer_label: str = "",
                    label_i18n: dict = None, explorer_label_i18n: dict = None) -> dict:
        if not uri:
            return {}
        type_key = _resolve_type_key(class_uri, explorer_label, explorer_label_i18n)
        if uri not in nodes:
            nodes[uri] = {"l": label or _get_local(uri), "t": type_key or "", "a": {}, "o": {}, "i": {}}
        nd = nodes[uri]
        if label and not nd["l"]:
            nd["l"] = label
        if type_key and not nd["t"]:
            nd["t"] = type_key
        # Additive: the key only appears on nodes that actually have a
        # translation, so a monolingual export is byte-identical to before.
        for lang, text in (label_i18n or {}).items():
            if not text:
                continue
            bucket = nd.setdefault("l_i18n", {})
            if not bucket.get(lang):
                bucket[lang] = text
        return nd

    def _row_i18n(row: dict, base: str) -> dict:
        """The `<base>@<tag>` cells of one row, empties dropped."""
        out = {}
        for lang in add_langs:
            text = (row.get(f"{base}@{lang}", "") or "").strip()
            if text:
                out[lang] = text
        return out

    inverse_of = ontology_store.get("_inverse_of", {})
    dot_one_edge_labels: dict = {}   # synthetic edge key -> precomputed label

    # Graph-Explorer-only per-edge display name override for a REGULAR
    # (non-dot-one) property, set on a specific canvas edge in the Studio
    # ("Explorer-Name" field on the edge editor). Deliberately scoped to
    # non-dot-one properties only -- dot-one qualifiers already have their
    # own, more delicate direction/merge logic (über/unter/...), and mixing
    # a second synthetic-key mechanism into that would risk quietly
    # breaking it. Edges that use the SAME custom name merge into the same
    # synthetic bucket (same label -> same slug -> same key); edges with no
    # override keep using the plain property URI, unaffected.
    edge_base_prop: dict = {}       # synthetic edge key -> original property URI (for inverse-of lookup)
    explorer_edge_labels: dict = {} # synthetic edge key -> custom label

    def _resolve_prop_key(prop_uri: str, explorer_label: str) -> str:
        if not prop_uri or not explorer_label:
            return prop_uri
        key = f"{prop_uri}#as:{_slugify(explorer_label)}"
        edge_base_prop[key] = prop_uri
        explorer_edge_labels[key] = explorer_label
        return key

    # Incoming (auto-derived) adjacency for REGULAR (non-dot-one) properties
    # is resolved in a SECOND pass, after every row's explicit "o" edge has
    # been written. This is what lets us detect and drop duplicates: when
    # both directions of a relation are explicitly present in the source
    # data, the auto-derived incoming entry would otherwise restate a fact
    # that's already shown via the target's own explicit "o" edge -- the
    # same neighbor showing up twice for the same relation. Processing "o"
    # edges to completion first lets us check "is this already explicitly
    # stated?" regardless of row order.
    #
    # Dot-One qualifiers do NOT use this "i"-bucket mechanism at all (see
    # below) -- their direction is already fully encoded in the qualifier
    # word itself (über vs. unter), so both the explicit and the derived
    # side are written straight into "o" and merge there naturally.
    pending_incoming: list = []   # (src_uri, tgt_uri, incoming_edge_uri)

    def add_outgoing(src_uri: str, edge_uri: str, tgt_uri: str, count: bool = True):
        if not src_uri or not edge_uri or not tgt_uri:
            return
        src = nodes.get(src_uri)
        tgt = nodes.get(tgt_uri)
        if src is None or tgt is None:
            return
        if edge_uri not in src["o"]:
            src["o"][edge_uri] = []
        if tgt_uri not in src["o"][edge_uri]:
            src["o"][edge_uri].append(tgt_uri)
        if count:
            edge_counts[edge_uri] = edge_counts.get(edge_uri, 0) + 1

    def queue_incoming(src_uri: str, edge_uri: str, tgt_uri: str, incoming_edge_uri: str = None, suppress_incoming: bool = False):
        # Skipped entirely when the Studio edge has "No inverse" checked
        # (the user has explicitly opted out of auto-deriving the opposite
        # direction for this specific connection).
        if suppress_incoming or not src_uri or not edge_uri or not tgt_uri:
            return
        # Otherwise use an explicit override if given (dot-one qualifier
        # inversion), otherwise the ontology's declared inverse property
        # (owl:inverseOf) so the relationship reads correctly from the
        # target's side too, e.g. P46_is_composed_of forward /
        # P46i_forms_part_of backward instead of the same forward property
        # re-used in both directions.
        incoming_uri = incoming_edge_uri if incoming_edge_uri is not None else inverse_of.get(edge_uri, edge_uri)
        pending_incoming.append((src_uri, tgt_uri, incoming_uri))

    def apply_incoming():
        for src_uri, tgt_uri, incoming_uri in pending_incoming:
            tgt = nodes.get(tgt_uri)
            if tgt is None:
                continue
            # Already explicitly stated in this exact direction (a row for
            # the reverse relation exists) -- don't add a duplicate, the
            # explicit "o" edge on tgt already shows it. tgt's explicit edge
            # may itself sit under a synthetic per-edge-label key, so resolve
            # every one of tgt's outgoing keys back to its base property
            # before comparing, instead of only checking an exact key match.
            already_explicit = any(
                src_uri in members
                for key, members in tgt["o"].items()
                if edge_base_prop.get(key, key) == incoming_uri
            )
            if already_explicit:
                continue
            if incoming_uri not in tgt["i"]:
                tgt["i"][incoming_uri] = []
            if src_uri not in tgt["i"][incoming_uri]:
                tgt["i"][incoming_uri].append(src_uri)

    # rdfs:Literal "range" nodes are free-text values modelled as canvas nodes
    # (a property can't stand alone in the Studio). Rather than emit them as
    # standalone leaf nodes + an edge, we FOLD their text into the domain
    # node's attributes -- so notes/descriptions read as node properties like
    # in a normal graph. Shared with the literal-row loop below (same keying,
    # merge and cross-property collision handling, same source map) so a value
    # arriving via a literal column and one via a literal node behave alike.
    RDFS_LITERAL = "http://www.w3.org/2000/01/rdf-schema#Literal"
    attr_prop_source: dict = {}   # nodeId -> { attr_key -> producing property uri }

    def add_literal_attr(d_uri: str, prop: str, value: str, base_key: str):
        # `a` is a flat, single-valued dict, so two situations need care instead
        # of "last write silently wins":
        #   * SAME property carrying several values on one node (multi-valued
        #     literal -- e.g. several notes) -> merge the values;
        #   * DIFFERENT properties whose keys collide -> keep both under a
        #     disambiguated key ("key", "key#2", ...).
        nd = nodes.get(d_uri)
        if nd is None or not value:
            return
        bk = base_key or (_get_local(prop) if prop else "value")
        sources = attr_prop_source.setdefault(d_uri, {})
        key = bk
        n = 2
        while key in nd["a"] and sources.get(key) != prop:
            key = f"{bk}#{n}"
            n += 1
        if key not in nd["a"]:
            nd["a"][key] = value
            sources[key] = prop
        else:                                   # same property again -> merge
            existing = nd["a"][key]
            parts = existing.split("; ") if isinstance(existing, str) else [str(existing)]
            if value not in parts:
                nd["a"][key] = existing + "; " + value if isinstance(existing, str) else value

    # Process URI rows
    for row in uri_rows:
        d_uri   = _safe_uri(row.get("id_of_domain_uri", ""))
        d_class = _safe_uri(row.get("class_of_domain_uri", ""))
        d_label = row.get("domain_label", "").strip()
        r_uri   = _safe_uri(row.get("id_of_the_range_uri", ""))
        r_class = _safe_uri(row.get("class_of_the_range_uri", ""))
        r_label = row.get("range_label", "").strip()
        prop    = _safe_uri(row.get("property_uri", ""))
        p3_note = row.get("p3_has_note", "").strip()
        dot_one_target = row.get("dot_one_target_uri", "").strip()
        no_inverse = row.get("no_inverse", "").strip().lower() in ("1", "true", "yes", "x")
        d_explorer_label = row.get("domain_explorer_label", "").strip()
        r_explorer_label = row.get("range_explorer_label", "").strip()
        prop_explorer_label = row.get("property_explorer_label", "").strip()
        inverse_prop_override = _safe_uri(row.get("inverse_property_uri", ""))

        if not d_uri:
            continue
        d_label_i18n    = _row_i18n(row, "domain_label")
        r_label_i18n    = _row_i18n(row, "range_label")
        d_explorer_i18n = _row_i18n(row, "domain_explorer_label")
        r_explorer_i18n = _row_i18n(row, "range_explorer_label")
        d_nd = ensure_node(d_uri, d_class, d_label, d_explorer_label,
                           d_label_i18n, d_explorer_i18n)
        if p3_note:
            d_nd["a"]["note"] = p3_note

        if r_uri and r_class == RDFS_LITERAL:
            # Free-text literal modelled as a canvas node -> fold its text into
            # the domain node's attributes instead of a standalone leaf node +
            # edge. Key by the literal node's own Explorer-Name ("Anmerkung
            # Fund", "Befundbeschreibung", ...) so several literal kinds sharing
            # ONE property (e.g. both hang off P3_has_note) stay distinct fields
            # instead of collapsing into one. r_label holds the text.
            add_literal_attr(
                d_uri, prop, r_label,
                base_key=(r_explorer_label or prop_explorer_label or _get_local(prop) or "value"),
            )
        elif r_uri:
            ensure_node(r_uri, r_class, r_label, r_explorer_label,
                        r_label_i18n, r_explorer_i18n)
            if dot_one_target:
                # Dot-One annotated edge (e.g. AP11_has_physical_relation_to
                # .1 AP11.1_has_type "above"): split the base property into
                # one edge-type group per qualifier value, so "über"/"unter"/
                # "gleichzeitig"/"entspricht" etc. show up as distinct,
                # correctly-directed groups instead of one undifferentiated
                # property. The base property itself is used unchanged (it's
                # typically symmetric in the ontology) -- only the qualifier
                # value is inverted for the other side.
                #
                # Both sides go into "o", not "i": the qualifier word already
                # says everything about direction ("über" vs "unter"), so
                # there is no separate outgoing/incoming distinction to make
                # here the way there is for a real property pair like
                # P46/P46i. Writing the derived side into "o" too means it
                # merges (via add_outgoing's existing append-if-not-present
                # dedup) with any explicit "o" entry the range node already
                # has under that exact same canonical key -- e.g. if SE2007
                # explicitly has "unter SE2006" AND SE2006 explicitly has
                # "über SE2007", both resolve to the identical key and end up
                # as ONE group instead of two identically-labelled ones split
                # across "o"/"i". `count=False` on the derived side keeps the
                # Overview edge-type stats matching the number of actual TSV
                # rows, not double-counting each relation from both ends.
                raw_text = _dot_one_raw_text(dot_one_target)
                value_label = _dot_one_label(raw_text)
                inv_value_label = _dot_one_inverse_label(raw_text)
                out_key = _dot_one_edge_key(prop, raw_text)
                in_key = _dot_one_edge_key(prop, inv_value_label)
                base_label = resolve_edge_label(prop)
                dot_one_edge_labels[out_key] = f"{base_label} ({value_label})"
                add_outgoing(d_uri, out_key, r_uri)
                if not no_inverse:
                    dot_one_edge_labels[in_key] = f"{base_label} ({inv_value_label})"
                    add_outgoing(r_uri, in_key, d_uri, count=False)
            else:
                # A per-edge Explorer-Name override (set on this specific
                # Studio connection) buckets this row under a synthetic key
                # derived from the label, so two edges using the same base
                # property but different custom names show up as distinct
                # groups, while two edges given the SAME custom name merge
                # into one (same label -> same slug -> same key). Edges
                # without an override keep using the plain property URI.
                # The incoming/auto-derived-inverse side intentionally
                # always resolves via the REAL property, not the synthetic
                # key -- either a manually specified inverse (set on this
                # connection in the edge editor, for properties without a
                # declared owl:inverseOf, e.g. custom/free-text properties)
                # or, failing that, the ontology's declared inverse, so the
                # reverse direction shows a real inverse relation rather than
                # an (undefined) inverse of a made-up label.
                out_key = _resolve_prop_key(prop, prop_explorer_label)
                add_outgoing(d_uri, out_key, r_uri)
                incoming_uri = inverse_prop_override or inverse_of.get(prop, prop)
                queue_incoming(d_uri, out_key, r_uri, incoming_edge_uri=incoming_uri, suppress_incoming=no_inverse)

    apply_incoming()

    # Process literal rows — add as attributes on the domain node, via the same
    # helper (and shared source map) used for folded rdfs:Literal nodes above,
    # keyed by the property's local name.
    for row in lit_rows:
        d_uri  = _safe_uri(row.get("id_of_domain_uri", ""))
        prop   = _safe_uri(row.get("property_uri", ""))
        value  = row.get("id_of_the_range_uri", "").strip()
        if not d_uri or not value:
            continue
        add_literal_attr(d_uri, prop, value, base_key=_get_local(prop) if prop else "value")

    # Build node_types and edge_types counts
    type_counts: dict = {}
    for nd in nodes.values():
        t = nd["t"]
        if t:
            type_counts[t] = type_counts.get(t, 0) + 1

    # Build schema block
    # Enrich type_labels and type_colors from request + ontology lookup
    ns  = get_namespaces() if g else {}

    schema_type_colors: dict = {}
    schema_type_labels: dict = {}
    schema_edge_labels: dict = {}
    schema_type_labels_i18n: dict = {}   # { lang: { typeKey: label } }
    schema_edge_labels_i18n: dict = {}   # { lang: { edgeUri: label } }

    for idx, t_uri in enumerate(sorted(type_counts.keys())):
        # A synthetic Explorer-labelled key (".../E55_Type#as:material") isn't
        # a real ontology URI -- resolve its color via the underlying CIDOC
        # class so CRM-anchor matching (and any explicit canvas color, which
        # the frontend only ever keys by the real class URI) still applies.
        color_lookup_uri = type_base_class.get(t_uri, t_uri)
        schema_type_colors[t_uri] = _color_for_type(color_lookup_uri, idx, req.type_colors)
        # Label: the Studio's per-node "Explorer-Name" override always wins
        # (that's the whole point -- it replaces the CIDOC class name for
        # this specific node's instances). Otherwise prefer provided, then
        # rdfs:label from ontology, then humanised local name.
        if t_uri in explorer_type_labels:
            schema_type_labels[t_uri] = explorer_type_labels[t_uri]
        elif t_uri in req.type_labels:
            schema_type_labels[t_uri] = req.type_labels[t_uri]
        elif g:
            from rdflib import URIRef as RDFURIRef
            rdfs_lbl = _preferred_literal(g, RDFURIRef(color_lookup_uri), RDFS.label)
            schema_type_labels[t_uri] = str(rdfs_lbl) if rdfs_lbl else _humanise(color_lookup_uri)
        else:
            schema_type_labels[t_uri] = _humanise(color_lookup_uri)

        # Same precedence per additional language: the user's Explorer name in
        # that language first, then an rdfs:label carrying exactly that tag.
        # Nothing is written when neither exists — the Explorer then falls back
        # to the primary label rather than showing the same text twice under
        # two language headings.
        for lang in add_langs:
            text = explorer_type_labels_i18n.get(lang, {}).get(t_uri)
            if not text and g:
                from rdflib import URIRef as RDFURIRef
                lit = _literal_in_lang(g, RDFURIRef(color_lookup_uri), RDFS.label, lang)
                text = str(lit) if lit else None
            if text:
                schema_type_labels_i18n.setdefault(lang, {})[t_uri] = text

    # Label every edge type actually used in the graph (both the forward
    # properties counted in edge_counts and any inverse properties that only
    # show up on the "i" side via owl:inverseOf resolution above).
    all_edge_uris: set = set(edge_counts.keys())
    for nd in nodes.values():
        all_edge_uris.update(nd["o"].keys())
        all_edge_uris.update(nd["i"].keys())

    for e_uri in sorted(all_edge_uris):
        schema_edge_labels[e_uri] = resolve_edge_label(e_uri)
        # Edges carry no per-language user text — an Explorer name on an edge
        # names a property, and the Explorer groups by it, so it stays single.
        # A translated edge caption can therefore only come from the ontology.
        if g and add_langs:
            from rdflib import URIRef as RDFURIRef
            for lang in add_langs:
                lit = _literal_in_lang(g, RDFURIRef(e_uri), RDFS.label, lang)
                if lit:
                    schema_edge_labels_i18n.setdefault(lang, {})[e_uri] = str(lit)
    # Dot-One synthetic keys aren't real ontology URIs -- always use the
    # precomputed "base property (qualifier)" label rather than the generic
    # ontology/humanise fallback above.
    schema_edge_labels.update(dot_one_edge_labels)
    # Same reasoning for per-edge Explorer-Name synthetic keys: override the
    # generic humanised fallback with the user's custom label.
    schema_edge_labels.update(explorer_edge_labels)

    total_edges = sum(edge_counts.values())

    result = {
        "meta": {
            "title": req.title,
            "node_count": len(nodes),
            "edge_count": total_edges,
            "generated_by": "OntoCartographer Studio",
        },
        "nodes": nodes,
        "node_types": type_counts,
        "edge_types": edge_counts,
        "schema": {
            "typeColors": schema_type_colors,
            "typeLabels": schema_type_labels,
            "edgeLabels": schema_edge_labels,
            "mainAttrs":  {},   # can be extended in future
        },
    }
    # Only present once the project actually has more than one language, so a
    # monolingual export keeps the exact shape the Explorer reads today.
    if add_langs:
        result["languages"] = {"primary": req.primary_lang, "additional": add_langs}
        if schema_type_labels_i18n:
            result["schema"]["typeLabelsI18n"] = schema_type_labels_i18n
        if schema_edge_labels_i18n:
            result["schema"]["edgeLabelsI18n"] = schema_edge_labels_i18n
    return result


# ─── Graph Import (existing RDF / Graph-Explorer JSON → canvas model) ─────────

@app.post("/import/graph")
async def import_graph(file: UploadFile = File(...)):
    """
    Import an existing INSTANCE graph and return it lifted onto the Studio's
    schema model: one class group per rdf:type (with its instances as a
    synthetic table), plus the relation and literal patterns between them.

    The frontend turns each group into an ordinary mapped node, so everything
    downstream — re-classing, re-connecting, verification, RDF and Graph
    Explorer export — runs through the existing code paths unchanged.
    """
    import json as _json
    import graph_import as gi

    if not RDFLIB_AVAILABLE:
        raise HTTPException(500, "rdflib not installed. Run: pip install rdflib")

    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file.")
    filename = file.filename or "import"

    # The ontology (when loaded) only sharpens the result: it resolves the most
    # specific rdf:type for multi-typed resources and supplies prefixed labels.
    superclasses = ontology_store.get("_superclasses", {})
    ns = get_namespaces() if ontology_store.get("merged") is not None else {}

    def prefix_label(uri: str) -> str:
        return get_prefix_label(uri, ns)

    try:
        if filename.lower().endswith(".json"):
            try:
                data = _json.loads(content.decode("utf-8", errors="replace"))
            except Exception as exc:
                raise HTTPException(400, f"Invalid JSON: {exc}")
            # A Studio PROJECT file is also .json — say so explicitly instead of
            # failing on the differently shaped 'nodes' field.
            if isinstance(data, dict) and isinstance(data.get("nodes"), list):
                raise HTTPException(400, "This is a Studio project file — open it with 'Load', not 'Import graph'.")
            return gi.import_graph_json(data, get_local_name, prefix_label)

        return gi.import_rdf(content, filename, superclasses, get_local_name, prefix_label)
    except gi.ImportError_ as exc:
        raise HTTPException(400, str(exc))

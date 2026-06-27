#!/usr/bin/env python3
"""Graphify-build voor de Homey-app com.ems.homey (JavaScript / Homey SDK3).

Bouwt EEN samenhangende knowledge-graph uit vier bronnen:
  1. services/managers/drivers/widgets + app.js/api.js -> AST (tree-sitter, gratis)
  2. tools/                                             -> AST (test-/diag-scripts)
  3. app.json drivers + capabilities                    -> "datamodel" (device-model)
  4. ems:-event-bus + flow-kaarten                       -> "wiring" (de brug code<->flow)

De wiring is hier de échte hefboom: een Homey-app mag géén flow-acties van een ander
device draaien, dus de communicatie loopt via `this.homey.emit('ems:X')` (in de code)
-> `this.homey.on('ems:X')` (in managers/FlowManager.js) -> `trigger('flow_card')`
(app.json flow.triggers). Die keten bridgen we naar de AST-file-nodes, zodat je in één
traversal ziet welke code welke flow-kaart voedt.

Node-id-schema van graphify's JS-AST (empirisch): file = `{dir}_{stem}` (bv.
`services_teslascheduler`), class = `{dir}_{stem}_{class}`, method `..._{method}`.
De wiring reconstrueert het FILE-id zodat z'n edges aan de echte code-nodes hangen.

Geen LLM, geen tokens voor de parsers. Run via scripts/graphify/build.sh.
"""
import json, re, sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]   # repo root (scripts/graphify/ -> ..)
OUT = ROOT / "graphify-out"
OUT.mkdir(exist_ok=True)

from graphify.extract import collect_files, extract
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json

# ── CONFIG: Homey-app-stack ──────────────────────────────────────────────────
CODE_DIRS  = ["services", "managers", "drivers", "devices", "widgets"]   # app-code (AST)
ROOT_FILES = ["app.js", "api.js"]                             # root-level app-code
TEST_DIRS  = ["tools"]                                        # test-/diag-scripts (AST)
CODE_EXTS  = (".js",)
APPJSON    = "app.json"                                       # device-model + flow-kaarten
FLOWMGR    = "managers/FlowManager.js"                        # ems:-event -> flow-kaart-brug
DOC_DIRS   = ["docs"]                                         # documentatie (node + doc->code-brug)
# ─────────────────────────────────────────────────────────────────────────────

PATH_RE = re.compile(r"[A-Za-z0-9_./-]+\.[A-Za-z0-9]+")       # bestandspad-/naam-tokens in docs

def norm(s): return re.sub(r"[^a-z0-9]", "_", (s or "").lower())

def file_node_id(relpath):
    """Reconstrueer graphify's AST FILE-node-id uit een repo-relatief pad."""
    p = Path(relpath)
    return f"{norm(p.parent.name)}_{norm(p.stem)}"

def _node(i, label, src):
    return {"id": i, "label": label, "file_type": "code", "source_file": src,
            "source_location": None, "source_url": None, "captured_at": None,
            "author": None, "contributor": None}

def _edge(s, t, rel, src):
    return {"source": s, "target": t, "relation": rel, "confidence": "EXTRACTED",
            "confidence_score": 1.0, "source_file": src, "source_location": None, "weight": 1.0}

# ── 1+2. AST-bronnen ─────────────────────────────────────────────────────────
def _js_files(dirs, files):
    fs = []
    for d in dirs:
        p = ROOT / d
        if p.exists():
            fs += [f for f in collect_files(p) if f.suffix in CODE_EXTS]
    for fn in files:
        p = ROOT / fn
        if p.exists() and p.suffix in CODE_EXTS:
            fs.append(p)
    return sorted(set(fs))

def ast_extract(label, fs):
    if not fs:
        return {"nodes": [], "edges": []}
    res = extract(fs, cache_root=ROOT)
    print(f"  AST {label}: {len(res['nodes'])} nodes, {len(res['edges'])} edges ({len(fs)} files)")
    return res

# ── 3. DATAMODEL: device-model uit app.json (drivers + capabilities) ─────────
def datamodel_extract():
    f = ROOT / APPJSON
    if not f.exists():
        return {"nodes": [], "edges": []}
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  datamodel: app.json onleesbaar ({e})"); return {"nodes": [], "edges": []}
    nodes, edges, seen = [], [], set()
    def add(i, label):
        if i in seen: return i
        seen.add(i); nodes.append(_node(i, label, APPJSON)); return i
    n_drv = 0
    for drv in data.get("drivers", []) or []:
        did = add(f"driver_{norm(drv.get('id', ''))}", f"driver:{drv.get('id', '?')}"); n_drv += 1
        for cap in drv.get("capabilities", []) or []:
            cid = add(f"cap_{norm(cap)}", f"cap:{cap}")
            edges.append(_edge(did, cid, "references", APPJSON))
    for cap in (data.get("capabilities") or {}):
        add(f"cap_{norm(cap)}", f"cap:{cap}")
    print(f"  datamodel(app.json): {n_drv} drivers, {len(nodes)} nodes, {len(edges)} edges")
    return {"nodes": nodes, "edges": edges}

# ── 4. WIRING: ems:-event-bus + flow-kaarten (de brug code<->flow) ───────────
EMIT_RE = re.compile(r"""\.emit\(\s*['"]ems:(\w+)['"]""")
ON_RE   = re.compile(r"""\.on\(\s*['"]ems:(\w+)['"]""")
TRIG_RE = re.compile(r"""(?:trigger|_fire)\(\s*['"]([a-z0-9_]+)['"]""")
ONLOC_RE = re.compile(r"""\.on\(\s*['"]ems:(\w+)['"]""")

def wiring_extract(js_files):
    f = ROOT / APPJSON
    data = {}
    if f.exists():
        try: data = json.loads(f.read_text(encoding="utf-8"))
        except Exception: data = {}
    nodes, edges, seen = [], [], set()
    def add(i, label, src):
        if i in seen: return i
        seen.add(i); nodes.append(_node(i, label, src)); return i

    # 4a. flow-kaarten uit app.json (de "contract"-laag)
    flow = data.get("flow") or {}
    card_ids = set()
    for kind in ("triggers", "conditions", "actions"):
        for card in flow.get(kind, []) or []:
            cid = card.get("id")
            if not cid: continue
            card_ids.add(cid)
            add(f"flow_{norm(cid)}", f"flow:{cid}", APPJSON)

    # 4b. emits/ons per code-bestand -> event-nodes, gebridged naar de AST-file-node
    ev_seen = set()
    n_emit = n_on = 0
    for jf in js_files:
        try: rel = str(jf.relative_to(ROOT))
        except Exception: continue
        fid = file_node_id(rel)
        try: txt = jf.read_text(encoding="utf-8", errors="ignore")
        except Exception: continue
        for ev in sorted(set(EMIT_RE.findall(txt))):
            evid = add(f"event_ems_{norm(ev)}", f"ems:{ev}", rel); ev_seen.add(ev)
            edges.append(_edge(fid, evid, "references", rel)); n_emit += 1   # code emit event
        for ev in sorted(set(ON_RE.findall(txt))):
            evid = add(f"event_ems_{norm(ev)}", f"ems:{ev}", rel); ev_seen.add(ev)
            edges.append(_edge(evid, fid, "references", rel)); n_on += 1     # event handled by code

    # 4c. ems:-event -> flow-kaart, uit FlowManager (venster ná elke .on('ems:X'))
    fm = ROOT / FLOWMGR
    n_map = 0
    if fm.exists():
        try: ftxt = fm.read_text(encoding="utf-8", errors="ignore")
        except Exception: ftxt = ""
        for m in ONLOC_RE.finditer(ftxt):
            ev = m.group(1)
            window = ftxt[m.end(): m.end() + 400]
            for card in TRIG_RE.findall(window):
                if card in card_ids:
                    edges.append(_edge(f"event_ems_{norm(ev)}", f"flow_{norm(card)}",
                                       "shares_data_with", FLOWMGR)); n_map += 1
    print(f"  wiring: {len(card_ids)} flow-kaarten, {len(ev_seen)} ems-events "
          f"({n_emit} emits, {n_on} ons), {n_map} event->kaart-edges")
    return {"nodes": nodes, "edges": edges}

# ── 5. DOCS: node per .md + doc->code-edges via pad-/naam-referenties (geen LLM) ──
def docs_extract(code_rel_paths):
    by_id, by_name = set(), {}
    for rel in code_rel_paths:
        fid = file_node_id(rel); by_id.add(fid)
        by_name.setdefault(Path(rel).name.lower(), fid)
    nodes, edges, seen = [], [], set()
    def add(i, label, src):
        if i in seen: return i
        seen.add(i)
        nodes.append({"id": i, "label": label, "file_type": "document", "source_file": src,
                      "source_location": None, "source_url": None, "captured_at": None,
                      "author": None, "contributor": None}); return i
    n_doc = n_link = 0
    for d in DOC_DIRS:
        base = ROOT / d
        if not base.exists(): continue
        for f in sorted(base.rglob("*.md")):
            rel = str(f.relative_to(ROOT))
            did = add(f"doc_{norm(rel)}", f.name, rel); n_doc += 1
            try: txt = f.read_text(encoding="utf-8", errors="ignore")
            except Exception: continue
            targets = set()
            for tok in PATH_RE.findall(txt):
                cand = file_node_id(tok) if "/" in tok else None
                if cand and cand in by_id: targets.add(cand)
                else:
                    nm = Path(tok).name.lower()
                    if nm in by_name: targets.add(by_name[nm])
            for t in targets:
                edges.append(_edge(did, t, "references", rel)); n_link += 1
    print(f"  docs: {n_doc} documenten, {n_link} doc->code-edges")
    return {"nodes": nodes, "edges": edges}

# ── merge + build ────────────────────────────────────────────────────────────
def main():
    print("Bronnen extraheren...")
    app_files  = _js_files(CODE_DIRS, ROOT_FILES)
    test_files = _js_files(TEST_DIRS, [])
    all_js = app_files + test_files
    rels = [str(f.relative_to(ROOT)) for f in all_js]
    sources = [
        ast_extract("app-code", app_files),
        ast_extract("tools", test_files),
        datamodel_extract(),
        wiring_extract(all_js),
        docs_extract(rels),
    ]
    sem_path = OUT / ".graphify_semantic.json"
    if sem_path.exists():
        sources.append(json.loads(sem_path.read_text()))
        print(f"  Docs (semantic, bestaand): {len(sources[-1].get('nodes', []))} nodes")

    nodes, seen, edges, hyper = [], set(), [], []
    for d in sources:
        for n in d.get("nodes", []):
            if n["id"] not in seen:
                seen.add(n["id"]); nodes.append(n)
        edges += d.get("edges", [])
        hyper += d.get("hyperedges", [])
    extract_obj = {"nodes": nodes, "edges": edges, "hyperedges": hyper,
                   "input_tokens": 0, "output_tokens": 0}
    (OUT / ".graphify_extract.json").write_text(json.dumps(extract_obj, ensure_ascii=False))
    print(f"Merged: {len(nodes)} nodes, {len(edges)} edges")

    G = build_from_json(extract_obj, root=None, directed=False)
    communities = cluster(G)
    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    meta = {n: G.nodes[n] for n in G.nodes}

    def label_for(cid, members):
        d = Counter()
        for m in members:
            sf = meta.get(m, {}).get("source_file", "") or ""
            if sf == APPJSON: d["__MODEL__"] += 4
            elif sf.endswith(".md"): d["__DOCS__"] += 3
            elif sf == FLOWMGR or sf.startswith("managers/"): d["__WIRING__"] += 2
            elif sf.startswith("widgets/"): d["__WIDGET__"] += 2
            elif sf.startswith("tools/"): d["__TOOLS__"] += 2
            p = sf.split("/"); d["/".join(p[:2]) if len(p) >= 2 else (p[0] if p else "?")] += 1
        top = d.most_common(1)[0][0] if d else "?"
        return {"__MODEL__": "Device-model & flow-kaarten (app.json)",
                "__DOCS__": "Documentatie (docs/)",
                "__WIRING__": "Flow-wiring (managers/events)",
                "__WIDGET__": "Widgets", "__TOOLS__": "Tools/tests"}.get(top, top)

    labels = {cid: (label_for(cid, mem) if len(mem) >= 6 else f"Community {cid}")
              for cid, mem in communities.items()}
    questions = suggest_questions(G, communities, labels)
    wrote = to_json(G, communities, str(OUT / "graph.json"), force=True, community_labels=labels)
    src_files = {meta.get(n, {}).get("source_file", "") for n in G.nodes}; src_files.discard("")
    detection = {"total_files": len(src_files), "total_words": 0, "files": {}}
    report = generate(G, communities, cohesion, labels, gods, surprises,
                      detection, {"input": 0, "output": 0}, ".", suggested_questions=questions)
    (OUT / "GRAPH_REPORT.md").write_text(report)
    (OUT / ".graphify_labels.json").write_text(
        json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False))
    print(f"GEBOUWD: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, "
          f"{len(communities)} communities (graph.json geschreven={wrote})")

if __name__ == "__main__":
    sys.exit(main())

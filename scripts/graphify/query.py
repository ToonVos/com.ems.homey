#!/usr/bin/env python3
"""Gerichte graph-queries op graphify-out/graph.json — pure stdlib, geen graphify-binary.

Bedoeld voor AI-commands (/initiate Scout, /specify §0, /review-pr impact) om
ground-truth uit de samenhangende graph te halen i.p.v. te grep-pen.

Modes:
  entity <Naam>      operations die de entity raken + gerelateerde entities (datamodel)
  neighbors <label>  alle in-/uitgaande edges van een node, gegroepeerd per relatie
  impact <label>     blast-radius: callers + operations die het raken + bereikbare routes/pages

Gebruik:  python3 scripts/graphify/query.py impact "updateA3"
Werkt alleen als de graph bestaat (build.sh / auto-refresh). Geen tokens.
"""
import json, sys, os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GRAPH = os.path.join(ROOT, "graphify-out", "graph.json")

def load():
    if not os.path.isfile(GRAPH):
        print(f"(geen graph — draai ./scripts/graphify/build.sh)  pad: {GRAPH}", file=sys.stderr)
        sys.exit(2)
    # Defensief tegen een afwijkend export-schema (Codex R1 high #2): nooit KeyError-crashen —
    # schone exit 2 zodat de aanroeper terugvalt op grep i.p.v. een stacktrace.
    try:
        with open(GRAPH) as f:
            g = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"(graph onleesbaar: {e}) — val terug op grep/Read", file=sys.stderr)
        sys.exit(2)
    links = g.get("links") or g.get("edges") or []
    node_list = g.get("nodes") or []
    if not node_list:
        print("(graph mist 'nodes' — onbekend schema) — val terug op grep/Read", file=sys.stderr)
        sys.exit(2)
    nodes = {n["id"]: n for n in node_list if isinstance(n, dict) and "id" in n}
    out, inc = defaultdict(list), defaultdict(list)
    for e in links:
        s, t, r = e.get("source"), e.get("target"), e.get("relation")
        if s is None or t is None:
            continue
        out[s].append((r, t))
        inc[t].append((r, s))
    return nodes, out, inc

def norm(s): return s.lower().rstrip("()").strip()

def find(nodes, name, want_file=None):
    n = norm(name)
    hits = []
    for nid, nd in nodes.items():
        if norm(nd.get("label", "")) == n:
            if want_file and not (nd.get("source_file", "") or "").endswith(want_file):
                continue
            hits.append(nid)
    return hits

def lbl(nodes, i): return nodes.get(i, {}).get("label", "?")
def sf(nodes, i): return nodes.get(i, {}).get("source_file", "") or ""

def mode_entity(nodes, out, inc, name):
    hits = find(nodes, name, want_file="schema.prisma")
    if not hits:
        print(f"Geen entity '{name}' in de graph."); return
    for e in hits:
        print(f"# Entity: {lbl(nodes,e)}  [{sf(nodes,e)}]")
        rel = [t for r, t in out[e] if r in ("references", "shares_data_with") and sf(nodes, t).endswith("schema.prisma")]
        if rel:
            print(f"  relateert aan: {', '.join(sorted(set(lbl(nodes,t) for t in rel)))}")
        ops = [s for r, s in inc[e] if r == "shares_data_with" and sf(nodes, s) == "app/main.wasp"]
        print(f"  operations die deze entity raken ({len(set(ops))}):")
        for o in sorted(set(lbl(nodes, s) for s in ops)):
            print(f"    - {o}")

def mode_neighbors(nodes, out, inc, name):
    hits = find(nodes, name)
    if not hits:
        print(f"Geen node '{name}' in de graph."); return
    for h in hits[:4]:
        print(f"# {lbl(nodes,h)}  [{sf(nodes,h)}]")
        byrel = defaultdict(set)
        for r, t in out[h]: byrel[f"→ {r}"].add(lbl(nodes, t))
        for r, s in inc[h]: byrel[f"← {r}"].add(lbl(nodes, s))
        for r in sorted(byrel):
            items = sorted(byrel[r])
            print(f"  {r} ({len(items)}): {', '.join(items[:12])}{' …' if len(items) > 12 else ''}")

def mode_impact(nodes, out, inc, name):
    hits = find(nodes, name)
    if not hits:
        print(f"Geen node '{name}' in de graph."); return
    for h in hits[:3]:
        print(f"# Blast-radius: {lbl(nodes,h)}  [{sf(nodes,h)}]")
        # directe callers / verwijzers (reverse calls/references)
        callers = sorted(set(lbl(nodes, s) for r, s in inc[h] if r in ("calls", "references")))
        if callers:
            print(f"  ← aangeroepen/verwezen door ({len(callers)}): {', '.join(callers[:15])}{' …' if len(callers)>15 else ''}")
        # operations (main.wasp) die hiernaar verwijzen → hun entities
        ops = [s for r, s in inc[h] if sf(nodes, s) == "app/main.wasp"]
        for o in sorted(set(ops), key=lambda x: lbl(nodes, x)):
            ents = sorted(set(lbl(nodes, t) for r, t in out[o] if r == "shares_data_with"))
            print(f"  ⚙ operation {lbl(nodes,o)} → entities: {', '.join(ents[:8])}")
        # als dit een entity is: operations + (via die ops) niets verder; toon ops
        if sf(nodes, h).endswith("schema.prisma"):
            tops = sorted(set(lbl(nodes, s) for r, s in inc[h] if r == "shares_data_with" and sf(nodes, s) == "app/main.wasp"))
            print(f"  ⚙ operations op deze entity ({len(tops)}): {', '.join(tops[:20])}")

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    mode, name = sys.argv[1], " ".join(sys.argv[2:])
    nodes, out, inc = load()
    {"entity": mode_entity, "neighbors": mode_neighbors, "impact": mode_impact}.get(mode, lambda *a: print(f"onbekende mode: {mode}"))(nodes, out, inc, name)

if __name__ == "__main__":
    main()

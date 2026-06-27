#!/usr/bin/env bash
# PreToolUse hint + self-healing trigger voor graphify. Bij een verkennings-actie
# (grep/find of Read/Glob van broncode):
#   1. trapt een ACHTERGROND-refresh af als de graph stale is (refresh.sh, non-blocking)
#   2. geeft een zachte tip om de graph te raadplegen
# Nooit blokkerend (exit 0 altijd). Stil tenzij er een graph is én de actie relevant is.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." 2>/dev/null && pwd)" || exit 0
cd "$ROOT" || exit 0            # repo-root: graphify-out/ is root-relatief (zoals refresh.sh/build.sh)
GRAPH="graphify-out/graph.json"
[ -f "$GRAPH" ] || exit 0

INPUT="$(cat)"                  # volledige (mogelijk multi-line) JSON-payload, niet alleen regel 1

# Self-healing: herbouw op de achtergrond als stale (eigen lock/mtime-logica).
"$DIR/refresh.sh" >/dev/null 2>&1 || true

python3 - "$INPUT" "$GRAPH" <<'PY' 2>/dev/null || true
import json, sys, os, re, glob
raw = sys.argv[1] if len(sys.argv) > 1 else ""
graph = sys.argv[2]
try:
    d = json.loads(raw)
except Exception:
    sys.exit(0)
ti = d.get("tool_input", d)
tool = d.get("tool_name", "")

# Relevantie: alleen bij code-verkenning
if tool == "Bash":
    relevant = bool(re.search(r"\b(grep|rg|ripgrep|ag|ack|fd|find)\b", str(ti.get("command", ""))))
else:  # Read | Glob
    s = (str(ti.get("file_path") or "") + " " + str(ti.get("pattern") or "") + " " + str(ti.get("path") or "")).lower().replace("\\", "/")
    relevant = ("graphify-out/" not in s) and any(e in s for e in (".js", ".md", "app.json"))
if not relevant:
    sys.exit(0)

# Stale? (mtime: bron nieuwer dan graph) — zelfde signaal als refresh.sh
gmt = os.path.getmtime(graph)
stale = False
for base in ("services", "managers", "drivers", "devices", "widgets", "tools", "docs", "app.js", "api.js", "app.json"):
    if stale:
        break
    if os.path.isfile(base):
        stale = os.path.getmtime(base) > gmt
    else:
        for root, _dirs, files in os.walk(base):
            if any(f.endswith((".js", ".md", ".json")) and os.path.getmtime(os.path.join(root, f)) > gmt for f in files):
                stale = True
                break

if stale:
    msg = ("De code-graph (graphify-out/graph.json) wordt NU op de achtergrond ververst "
           "(bron gewijzigd). Voor deze actie: lees code direct of accepteer net-oude graph-data; "
           "volgende keer is hij vers.")
else:
    msg = ("Tip: er is een verse code-graph (graphify-out/graph.json — bronnen: JS-code "
           "(services/managers/drivers/devices/widgets) + device-model (app.json) + flow-wiring "
           "(ems:-events→flow-kaarten) + docs). Voor architectuur/samenhang-vragen (wie roept wat, "
           "welke code voedt flow-kaart X, impact, doc-rot) is een gerichte query op graph.json "
           "sneller dan grep. Voor code-logica/edits gewoon lezen.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": msg}}))
PY
exit 0

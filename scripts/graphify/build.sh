#!/usr/bin/env bash
# Standaard graphify-build voor LEAN AI COACH.
# Bouwt de samenhangende graph (app/src + e2e-tests + schema.prisma + main.wasp)
# naar <repo-root>/graphify-out/. Geen LLM, geen tokens.
#
# Gebruik:  ./scripts/graphify/build.sh
# Vereist:  graphify CLI (uv tool install graphifyy). Ontbreekt die -> no-op met hint.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# --- interpreter resolven (uv tool / pipx / pip shebang) ---
PY=""
if [ -f graphify-out/.graphify_python ]; then
  PY="$(cat graphify-out/.graphify_python)"
fi
if [ -z "$PY" ] || ! "$PY" -c "import graphify" 2>/dev/null; then
  BIN="$(command -v graphify 2>/dev/null || true)"
  if [ -n "$BIN" ]; then
    CAND="$(head -1 "$BIN" | tr -d '#!')"
    case "$CAND" in *[!a-zA-Z0-9/_.-]*) CAND="" ;; esac
    [ -n "$CAND" ] && "$CAND" -c "import graphify" 2>/dev/null && PY="$CAND"
  fi
fi
if [ -z "$PY" ] || ! "$PY" -c "import graphify" 2>/dev/null; then
  echo "⚠️  graphify niet geïnstalleerd — sla graph-build over."
  echo "   Installeer met: uv tool install graphifyy"
  exit 0
fi
mkdir -p graphify-out
echo "$PY" > graphify-out/.graphify_python

# Pin-check (Codex R1 high #2): waarschuw als de geïnstalleerde graphifyy afwijkt van de
# vastgelegde pin. Non-fatal — de AST-build is versie-robuust en een hard-fail zou de
# zelfhelende achtergrond-rebuild breken; query.py degradeert zelf schoon bij schema-drift.
_PINFILE="scripts/graphify/.graphify_version"
if [ -f .claude/skills/graphify/.graphify_version ]; then _PINFILE=.claude/skills/graphify/.graphify_version; fi
if [ -f "$_PINFILE" ]; then
  _WANT="$(tr -d '[:space:]' < "$_PINFILE")"
  _HAVE="$("$PY" -c "import importlib.metadata as m; print(m.version('graphifyy'))" 2>/dev/null || echo '?')"
  [ "$_HAVE" != "$_WANT" ] && echo "⚠️  graphifyy versie-drift: geïnstalleerd $_HAVE ≠ pin $_WANT (zie SKILL.md). Build gaat door (AST is versie-robuust)." >&2
fi

echo "🔧 Graph bouwen ($PY)..."
"$PY" scripts/graphify/build_graph.py

# --- HTML (community-view boven 5000 nodes) ---
if command -v graphify >/dev/null 2>&1; then
  graphify export html 2>&1 | tail -2 || true
fi

echo "✅ Graph klaar: $ROOT/graphify-out/  (graph.json · GRAPH_REPORT.md · graph.html)"

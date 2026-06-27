#!/usr/bin/env bash
# Zelfhelende graph-refresh. Herbouwt graphify-out/ in de ACHTERGROND als de graph
# stale is. Keert ALTIJD direct terug (gedetacheerde build) — veilig in een
# PreToolUse-hook (5s-timeout) en SessionStart.
#
# Staleness-signaal = mtime: is een bronbestand (app/src, schema.prisma, main.wasp,
# e2e-tests) nieuwer dan graph.json? Dan stale. Vangt committed ÉN uncommitted
# wijzigingen, pulls en branch-switches.
#
# Robuust: lockfile voorkomt gelijktijdige/stampede-builds; stale lock (>10min) wordt
# opgeruimd. Guarded: stille no-op zonder graphify-binary. Geen stdout (mag in hooks).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || exit 0
cd "$ROOT" || exit 0

GRAPH="graphify-out/graph.json"
LOCK="graphify-out/.build.lock"

command -v graphify >/dev/null 2>&1 || exit 0
[ -x scripts/graphify/build.sh ] || exit 0

# --- al een build bezig? (verse lock) → niets doen. Dode lock (>10min) opruimen. ---
if [ -f "$LOCK" ]; then
  if [ -n "$(find "$LOCK" -mmin +10 2>/dev/null)" ]; then
    rm -f "$LOCK"
  else
    exit 0
  fi
fi

# --- debounce: hoogstens 1 boom-walk per 30s (Codex R1 #4, owner: kostenbesparing) ---
# Alleen wanneer de graph al bestaat; ontbreekt hij → altijd doorgaan en bouwen.
STAMP="graphify-out/.last_check"
# Portable epoch-diff i.p.v. `find -mmin +0.5` (BSD/macOS weigert fractionele -mmin → zou
# de self-heal permanent uitschakelen; Codex R2 high). stat: BSD `-f %m` / GNU `-c %Y`.
if [ -f "$GRAPH" ] && [ -f "$STAMP" ]; then
  _now=$(date +%s)
  _last=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  [ "$((_now - _last))" -lt 30 ] && exit 0
fi
mkdir -p graphify-out && : > "$STAMP" 2>/dev/null || true

# --- staleness via mtime ---
need=0
if [ ! -f "$GRAPH" ]; then
  need=1
else
  newer="$(find services managers drivers widgets tools docs app.js api.js app.json \
            \( -name '*.js' -o -name '*.md' -o -name 'app.json' \) \
            -newer "$GRAPH" -print -quit 2>/dev/null || true)"
  [ -n "$newer" ] && need=1
fi
[ "$need" = 1 ] || exit 0

# --- lock + gedetacheerde achtergrond-build (lock wordt door de child opgeruimd) ---
mkdir -p graphify-out
printf '%s %s\n' "$$" "$(date +%s)" > "$LOCK"
# $ROOT als positionele arg ($1) i.p.v. string-interpolatie → robuust bij paden met spaties/metatekens.
nohup bash -c 'cd "$1" && ./scripts/graphify/build.sh >/dev/null 2>&1; rm -f "$1/graphify-out/.build.lock"' _ "$ROOT" >/dev/null 2>&1 &
exit 0

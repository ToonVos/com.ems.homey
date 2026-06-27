# Graphify — samenhangende code-graph voor com.ems.homey

Bouwt één knowledge-graph die **code ⇄ device-model ⇄ flow-wiring** verenigt, zodat je
cross-layer vragen in één traversal beantwoordt (bv. "welke code voedt flow-kaart X",
impact-analyse, dead-code). Gebaseerd op de portable blueprint (`PORTABLE-SETUP.md` in
het LEANAICOACH-project).

## Versie-pin (supply-chain)

```bash
uv tool install graphifyy==0.8.49   # package = graphifyy (dubbel-y), CLI = graphify
graphify --version                  # → 0.8.49
```

## Gebruik

```bash
./scripts/graphify/build.sh                          # (her)bouw graphify-out/graph.json + graph.html
PY="$(cat graphify-out/.graphify_python)"
"$PY" scripts/graphify/query.py neighbors "ems:evChargeStuck"   # query op label
"$PY" scripts/graphify/query.py impact   "TeslaScheduler.js"    # wat raakt deze node
open graphify-out/graph.html                         # interactieve viewer (geen server)
```

## De bronnen (zie `build_graph.py`)

| Bron | Hoe | Stack-specifiek |
|------|-----|-----------------|
| App-code (services/managers/drivers/widgets + app.js/api.js) | graphify AST (.js) | ❌ generiek |
| tools/ (test-/diag-scripts) | graphify AST | ❌ generiek |
| **Device-model** | `app.json` drivers + capabilities → entity-nodes | ✅ Homey-specifiek |
| **Flow-wiring** | `homey.emit('ems:X')` → event → `homey.on` → `trigger('flow_card')` | ✅ Homey-specifiek |
| **Docs** | node per `docs/*.md` + doc→code-edges via pad-/naam-refs (geen LLM) | ✅ (doc-rot-detectie) |

De wiring is de hefboom: hij bridget de scheduler-code aan de flow-kaarten via de
`ems:`-event-bus (een Homey-app mag geen flow-acties van een ander device draaien).

## Auto-refresh (optioneel — zelf toevoegen)

De graph herbouwt zichzelf bij wijzigingen via een hook. Voeg dit toe aan
`.claude/settings.json` (vereist jouw goedkeuring; het draait scripts bij sessie-start):

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/graphify/refresh.sh", "timeout": 10 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Read|Glob", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/graphify/graph-hint.sh", "timeout": 5 }] }
    ]
  }
}
```

Zonder hooks: draai `./scripts/graphify/build.sh` handmatig na grotere wijzigingen.

## Hygiëne

- `graphify-out/` staat in `.gitignore` (bouwt lokaal, nooit committen).
- `scripts/graphify` + `graphify-out` + `*.py` staan in `.homeyignore` (niet meebundelen in de Homey-app).
- Wél committen: `scripts/graphify/*`.

## Grenzen

Graph = structuur, geen logica. AST-call-resolutie heeft false-negatives → impact is
triage, geen verdict; verifieer tegen de code.

# Terminal-spiekbriefje — Home EMS (fork)

Alles wat je in de terminal nodig hebt om de app te draaien en te testen.
Kopieer-plak de blokken. Je werkt altijd in de map `~/Projects/com.ems.homey`.

---

## De app draaien (dev-modus, met live logs)

```
cd ~/Projects/com.ems.homey
homey app run
```

- Dit zet de app live op je Homey Pro vanaf je laptop en toont **live logs**.
- De app draait zolang dit commando loopt. **Laat dit venster open.**
- In dev-modus is dit een test-versie; stop je 'm, dan verdwijnt de app weer van de Homey.

## Stoppen

Klik in het venster waar `homey app run` draait en druk:

```
Ctrl + C
```

(Control-toets vasthouden + C. Niet Cmd.) Je krijgt je prompt terug.

## Herstarten (na een code-wijziging van Claude)

Claude bewerkt de bestanden lokaal in deze map, dus na een wijziging hoef je
**niets te pullen** — alleen herstarten:

```
Ctrl + C
homey app run
```

> Tip: open eventueel een **tweede** terminal-tabblad (Cmd + T) voor losse
> commando's, dan hoef je `homey app run` niet te stoppen.

---

## Permanent installeren (pas later, als we live gaan — nu NIET nodig)

```
cd ~/Projects/com.ems.homey
homey app install
```

Anders dan `run` blijft de app dan op de Homey staan (ook als je laptop uit is)
en worden de `/userdata`-logbestanden duurzaam bewaard.

---

## Eenmalige setup (alleen als iets niet werkt)

```
homey login            # browser-login met je Athom-account
homey list             # toont je Homey('s)
homey select           # kies "Homey Pro van Toon" als actief doel
npm install            # app-dependencies (in ~/Projects/com.ems.homey)
```

---

## Zelf even de verzamelde data bekijken (optioneel)

De dry-run en beslis-log schrijven naar lokale bestanden. Laatste regels bekijken:

```
tail -n 5 ~/.athom-cli/apps-userdata/com.ems.homey/chargedryrun-$(date +%Y%m%d).jsonl
tail -n 5 ~/.athom-cli/apps-userdata/com.ems.homey/decisionlog-$(date +%Y%m%d).jsonl
```

Mooier leesbaar (als je `jq` hebt):

```
tail -n 3 ~/.athom-cli/apps-userdata/com.ems.homey/chargedryrun-$(date +%Y%m%d).jsonl | jq .
```

> Je hoeft dit niet zelf te analyseren — vraag Claude gewoon "lees de dry-run-data
> uit", dan doet hij de vergelijking verwachting-vs-werkelijkheid voor je.

---

## Wat draait er nu (modules)

| Wat je in de log ziet | Betekenis |
|---|---|
| `[DecisionLog] actief` + `snapshot #N` | Beslis-log (module 7) — legt elke 5 min alles vast |
| `[Battery] ... = autonome handelaar — sturing onderdrukt` | Module 1 — Nexus wordt met rust gelaten |
| `[ChargeDryRun] verwacht: ... \| werkelijk: ...` | Module 2 dry-run — berekent laden, stuurt NIETS |

Alles is **read-only / dry-run**: er gaan geen commando's naar de auto en het
kost geen Tesla-credits.

---

## Veelvoorkomend / ongevaarlijk in de log (negeren)

- `Device.driverUri is deprecated` — waarschuwing uit Menno's code, onschadelijk.
- `[DayAhead] Fetch error: ENTSO-E HTTP 401` — Menno's eigen prijs-pad (lege
  API-key). Wij gebruiken het Stroomprijzen-device, dus niet relevant.
- `[Learner] Bootstrap error: Not Found LogLocal` — leerling-historie ontbreekt;
  valt terug op default. Niet kritiek.
- `/userdata folder is not synced while developing` — in dev-modus zijn de
  logbestanden tijdelijk; dat is verwacht.

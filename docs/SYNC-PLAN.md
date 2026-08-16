# Sync- & bijdrageplan: fork → hoofdrepo

> Status: **voorbereiding, niets uitgevoerd.** Opgesteld 25 jun 2026,
> **geactualiseerd 3 jul 2026** (divergentie hergemeten, nieuwe upstream-overlap
> §1b, nieuwe fork-blokken P13–P15).
> Eigenaarschap-/licentie-/naamkwesties (BUSL-1.1, `com.ultimate.ems`) worden
> apart met Menno beslecht en zijn hier alleen als *afhankelijkheid* genoemd.

## 0. Uitgangssituatie (per 3 jul 2026)

| | |
|---|---|
| Fork (origin) | `ToonVos/com.ems.homey` |
| Hoofdrepo (upstream) | `b2hvty299s-ux/com.ems.homey` (v1.6.32, `com.ultimate.ems`, BUSL-1.1) |
| Merge-base | `6a97680` |
| Divergentie | fork **101 commits vóór**, upstream **70 commits áchter** |

**Upstream-veranderingen sinds split (kort):** licentie MIT → **BUSL-1.1**;
app-ID rename → **`com.ultimate.ems`** ("Ultimate EMS"); multi-PV-omvormers +
per-inverter fase-toewijzing; `AutonomousBattery`-interface + adapter; dual-thumb
SoC-slider; bug-report-knop; Tibber kwartierdata; diverse fixes.

**Nieuw sinds 25 jun (upstream, ~43 commits):** price-curve EV-laden in
`solar_and_grid` (`e25a85f`); PBTH-kwartierprijzen + volledige capabilities
(`6694f19`, `7294d59`); EMS ring-buffer-log + logviewer in settings (`af5a9d7`);
zero-export P1 closed-loop + PV-curtailment redesign (`d122b81`, `6c50ed9`);
Zendure local adapter + EV-priority battery headroom (`aeadbce`); API-inputvalidatie
(`9a885e8`); diverse fixes (spike-filter verwijderd, `ev_home`-semantiek,
`_detectBatteryType` retry).

**Werkwijze (vast):** (1) eerst fork syncen met upstream, (2) daarna kleine PR's
per onderwerp. Geen big-bang merge van 83 commits.

---

## 1. Conflict-inventaris (14 overlappende bestanden)

Diffstat = wijzigingen sinds merge-base aan beide kanten. "Risico" = handwerk bij
de merge.

| Bestand | Fork | Upstream | Risico | Aanpak |
|---|---|---|---|---|
| `managers/EmsManager.js` | +5 −2 | **+98 −27** | hoog | Upstream is leidend (multi-PV, autonome batterij). Fork-deltas zijn klein → handmatig terug-enten. |
| `services/DayAheadPrices.js` | +55 −3 | **+124 −5** | hoog | Beide breidden prijs-providers uit. Upstream Tibber-kwartier + fork EnergyZero/PbtH samenvoegen; provider-architectuur harmoniseren. |
| `settings/index.html` | +220 −11 | +222 −52 | hoog | Beide herschreven de UI fors. Waarschijnlijk grotendeels handmatig reconstrueren bovenop upstream (dual-thumb slider + multi-PV blijven). |
| `app.json` | +209 −18 | +133 −24 | hoog | Capabilities/flow-cards/settings van beide. Merge per sectie; app-ID-keuze (naam) is Menno-beslissing. |
| `devices/TeslaEvAdapter.js` | **+157 −12** | +35 −17 | midden | Fork is leidend (charge-detection/laadlimiet-brug). Upstream `set_charge_amps`-fallback (`edb7d37`) erin vlechten. |
| `api.js` | +132 −4 | +90 −0 | midden | Grotendeels additief (nieuwe routes). Naam-conflicten checken; meestal beide kanten houden. |
| `managers/FlowManager.js` | +34 −11 | +15 −1 | midden | Fork leidend (trigger-bruggen). Upstream-trigger(s) toevoegen. |
| `devices/EvChargeController.js` | +5 −0 | +44 −8 | midden | Upstream leidend; fork-delta klein → terug-enten. |
| `drivers/ems-controller/device.js` | +21 −0 | +20 −4 | midden | Beide additief; per-hunk mergen. |
| `LICENSE` | +27 −0 | +61 −0 | — | **Menno-beslissing** (MIT vs BUSL). Niet zelf oplossen. |
| `.homeychangelog.json` | +32 | +45 | laag | Mechanisch: beide changelog-blokken behouden, chronologisch. |
| `managers/PlanningEngine.js` | +2 −1 | +8 −2 | laag | Klein; per-hunk. |
| `devices/DeviceProfiler.js` | +1 −1 | +3 −3 | laag | Klein; per-hunk. |

**Let op — conceptuele dubbeling:** fork-module **m1 (autonome batterij
read-only)** overlapt met upstream `ef3dd4b` **`AutonomousBattery`-interface +
adapter**. Bij sync: upstream-abstractie als basis nemen, onze read-only-garantie
(P2: Nexus nooit aansturen) eroverheen borgen i.p.v. onze eigen variant ernaast.

## 1b. Nieuwe conceptuele overlap (upstream sinds 25 jun)

Menno bouwde intussen zélf functionaliteit die met onze blokken overlapt. Dit
verandert de framing van drie PR-thema's van "nieuw" naar "uitbreiding van wat
er al is" — cruciaal voor acceptatiekans:

| Fork-blok | Upstream-equivalent | Consequentie voor de PR |
|---|---|---|
| P2 prijs-providers (PbtH/EnergyZero) | PBTH-kwartierprijzen + capabilities (`6694f19`, `7294d59`) | PbtH-deel grotendeels vervallen; alleen EnergyZero-fullday en EpexPredictor-multiday als aanvulling aanbieden. |
| P3 Tesla-scheduler (prijsregie) | price-curve EV-laden in `solar_and_grid` (`e25a85f`) | Positioneren als **verdieping**: slot-planning met C_session, laadtijd-leermodel, wake-discipline, laadlimiet-als-stop — niet als concurrerende prijsmodus. Eerst met Menno afstemmen hoe dit zich tot zijn price-curve verhoudt. |
| P1 beslis-log (`DecisionLog`) | EMS ring-buffer-log + logviewer (`af5a9d7`) | Aanbieden als persistente JSONL-laag bovenop/naast zijn ring-buffer, of samenvoegen tot één log-architectuur. Overleg vóór code. |

---

## 2. Stap 1 — Sync de fork

1. **Veiligstellen:** lokale `main` (11 ahead) eerst naar `origin/main` pushen;
   `backup/pre-sync-<datum>`-tag/branch zetten.
2. **Sync-branch:** `sync/upstream-1.6.15` vanaf `main`.
3. **Merge `upstream/main`**; conflicten per bestand volgens §1.
   - Leidraad: fork wint op Tesla-scheduler/widget/trigger-bruggen/energie-ledger;
     upstream wint op multi-PV, per-inverter fase, `AutonomousBattery`,
     dual-thumb slider.
4. **Beslissingen toepassen** (na overleg Menno): app-ID + licentie.
5. **Verifiëren:** `homey app build` + validate; `homey app install` (nooit
   `app run`); gedrag toetsen tegen live debug-endpoints
   (`getTeslaScheduler` / `getState`).
6. **Mergen naar `main`** pas als de sync-branch stabiel draait.

---

## 3. Stap 2 — Kleine PR's per onderwerp (bovenop verse upstream)

Elke PR = branch vanaf `upstream/main`, cherry-pick van het cluster, schoon
houden. Volgorde = afhankelijkheid (laag eerst). Clusters uit de 83 commits:

| # | PR-thema | Kerncommits | Omvang | Afh. |
|---|---|---|---|---|
| P1 | Beslis-/snapshot-log (m7) | `ee5538b 5581ae4` | klein | — |
| P2 | Prijs-providers (EnergyZero/PbtH/EpexPredictor multiday) | `239d7a7 3d474e2 7bfdee0 e100c00 969b1c0 e0ff12f` | **groot** | harmoniseer met upstream Tibber-kwartier |
| P3 | Tesla-scheduler kern (prijs-gestuurde laadregie) | `a30f86a 3f0565e 2b06eb0 0c5a15d 872f504 0ead34b 8514027 84385ef` | **groot** | TeslaEvAdapter-merge §1 |
| P4 | Override-widget (laaddoel-tegel) | `ca5789b fbe2a12 5cf7312 96df41d 66595be` | midden | P3 |
| P5 | Spaarstand / verre-deadline-hold | `1035e2a db5254f 4e85413 11ef3fc 216da86` | midden | P3 |
| P6 | Laadtijd-leermodel (d07) | `a9ed947` | midden | P3 |
| P7 | Energie-boekhouding (d08) | `18a5acc` | **groot** | — |
| P8 | Homey Energy / ev-charger device + NoPower (d09) | `dd6be73 7319619 019b45f` | groot | P7 |
| P9 | Scheduler-robuustheid (event-driven + crash/off-by-one fixes) | `7b92727 d996328 de1327c d78ca45 22c41b4` | midden | P3 |
| P10 | Widget-robuustheid (retry/fitHeight/diagnostics) | `5aeab37 5c24577 67d4490 6d47077 e94e3f8` | klein | P4 |
| P11 | Notificaties/tijdlijn-categorieën | `d16334f dc90680` | klein | — |
| P12 | Settings-UI opruiming | `8ab6cd6 7b1a094 d05cfb2 6799a16 09d143b` | midden | merge §1 |
| P13 | Aging-premie (d10) + uurprijs-toggle + wake-betrouwbaarheid | `7d057a7 f6b9424` | midden | P3 |
| P14 | Observe-only meetlaag + bron-attributie (d11): `startObserver()`, EnergyLedger-attributie, accu-mix, levende deficit-drempel, chunk-endpoint | `a3af220 6ec5b75 7bfe113` | **groot** | P7 |
| P15 | Vijf dashboard-widgets (energiestromen, dagcurve+totalen, beslis-tijdlijn, waarom-nu, besparing) | `cc25e28 60af9f9 8128635 a8856b9 3c502a1` | groot | P14, P1 |
| P16 | Slot-optimalisatie O(n·N) + unit-tests (`test/slotSelection.test.js`) + sessiekost-fix | `3af4e38 f6b9424 60c3c28` | midden | P3 |
| P17 | Algemene flow-triggers dumplast/batterij-fallback + getSettings-endpoint | `b6cd33f 8155073` | klein | — |

**Niet naar upstream:** fork-setup/meta (`daaf5a7` FORK.md, package-lock-bumps,
versie-bumps, dode-code-removals tenzij relevant), graphify-tooling
(`3b634d5 8bacab0` — dev-tooling, hooguit apart aanbieden als hij wil) en pure
docs die fork-specifiek zijn. Module-2 dry-run (`bab4531` e.d.) was steiger —
niet meesturen.

**Eerst klein bewijzen:** begin met **P11 + P10 + P17** (klein, laag risico,
géén conceptuele overlap) om de PR-pijplijn met Menno te beproeven. Daarna P16
(tests mee = makkelijk te reviewen). P1/P2/P3 pas ná het overlap-gesprek (§1b);
de grote onderscheidende blokken (P7 boekhouding, P14 meetlaag, P15 widgets)
daarna in die volgorde.

---

## 4. Open afhankelijkheden (Menno)

- Licentie: MIT vs BUSL-1.1 — bepaalt of bijdragen juridisch kan/mag. Upstream
  is inmiddels definitief BUSL-1.1 (licensor MSDB Holding BV) — vóór de eerste
  PR moet helder zijn onder welke voorwaarden onze bijdragen worden opgenomen
  (zie intentieovereenkomst-traject in de brein-repo).
- App-ID/naam: upstream is `com.ultimate.ems` v1.6.32; fork volgt nog het oude ID.
- Volgorde/cadans van PR-review aan upstream-kant.
- Overlap-gesprek §1b: price-curve vs TeslaScheduler, ring-buffer vs DecisionLog —
  architectuurkeuze samen maken vóórdat we die PR's opsturen.

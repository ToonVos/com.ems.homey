# Sync- & bijdrageplan: fork → hoofdrepo

> Status: **voorbereiding, niets uitgevoerd.** Opgesteld 25 jun 2026.
> Eigenaarschap-/licentie-/naamkwesties (BUSL-1.1, `com.ultimate.ems`) worden
> apart met Menno beslecht en zijn hier alleen als *afhankelijkheid* genoemd.

## 0. Uitgangssituatie

| | |
|---|---|
| Fork (origin) | `ToonVos/com.ems.homey` |
| Hoofdrepo (upstream) | `b2hvty299s-ux/com.ems.homey` |
| Merge-base | `6a97680` |
| Divergentie | fork **83 commits vóór**, upstream **27 commits áchter** |
| Lokale `main` vs `origin/main` | **11 ahead, ongepusht** |

**Upstream-veranderingen sinds split (kort):** licentie MIT → **BUSL-1.1**;
app-ID rename → **`com.ultimate.ems`** ("Ultimate EMS"); multi-PV-omvormers +
per-inverter fase-toewijzing; `AutonomousBattery`-interface + adapter; dual-thumb
SoC-slider; bug-report-knop; Tibber kwartierdata; diverse fixes.

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

**Niet naar upstream:** fork-setup/meta (`daaf5a7` FORK.md, package-lock-bumps,
versie-bumps, dode-code-removals tenzij relevant) en pure docs die fork-specifiek
zijn. Module-2 dry-run (`bab4531` e.d.) was steiger — niet meesturen.

**Eerst klein bewijzen:** begin met **P1 + P11 + P10** (klein, laag risico) om de
PR-pijplijn met Menno te beproeven, dan de grote (P2/P3/P7).

---

## 4. Open afhankelijkheden (Menno)

- Licentie: MIT vs BUSL-1.1 — bepaalt of bijdragen juridisch kan/mag.
- App-ID/naam: blijven we `com.ultimate.ems` volgen of niet.
- Volgorde/cadans van PR-review aan upstream-kant.

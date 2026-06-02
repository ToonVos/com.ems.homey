# HEMS — Home Energy Management System
## Ontwerp- en Architectuurdocument

---

## 1. Doel en Visie

### Waarom dit systeem?

Steeds meer huishoudens hebben zonnepanelen, een elektrische auto en een thuisaccu. Elk apparaat heeft zijn eigen app die alleen naar zichzelf kijkt. Het gevolg: de zonnepanelen leveren terug aan het net terwijl de accu leeg is, of de EV laadt van het net terwijl de zon vol schijnt.

Het HEMS-systeem orkestreert alle energiestromen in één logica:

> **Gebruik zelf zoveel mogelijk van wat je opwekt. Laad de EV op zonnestroom. Bewaar genoeg in de accu voor de nacht. Lever pas terug als alles vol is.**

### Kernprincipes

1. **Zon is primair** — alles wat de EV en accu nodig hebben, komt bij voorkeur van de zon
2. **Geen klapperen** — systeem schakelt stabiel, geen aan/uit per minuut (B3/B4)
3. **Vooruitdenken** — dagplanning op basis van weersverwachting, niet alleen reactief
4. **Leren van gedrag** — eigen verbruikspatronen worden gemeten en gebruikt in de planning
5. **Transparantie** — alles zichtbaar in twee dashboard-widgets
6. **Uitbreidbaar zonder code** — nieuw apparaat toevoegen = config, niet een nieuwe klasse (A2)

---

## 2. Systeemarchitectuur

```
Open-Meteo API
     │ weersverwachting (straling W/m²)
     ▼
PlanningEngine ──────────────────────────────────────────────┐
  │ dagplan (schedule[24])                                    │
  ▼                                                           │
EmsManager (tick elke 60s)                                   │
  │                                                           │
  ├── HomeyDeviceAdapter  → grid meter  (A2 primair)         │
  ├── HomeyDeviceAdapter  → PV meter    (A2 primair)         │
  ├── HomeWizardAdapter   → fallback als A2 init mislukt     │
  ├── BatteryAdapter      → inverter (soc, powerW)           │
  ├── TeslaEvAdapter      → Wall Connector + Tesla app (B5)  │
  ├── EvChargeController  → laadlogica (B2/B3/B4)            │
  ├── ThermostatAdapter   → warmtepomp thermostaten           │
  └── DumpLoadAdapter     → overschot schakelaar (B4)        │
                                                              │
Homey flows ←──── FlowManager (trigger cards) ←─────────────┘
Dashboard   ←──── Widgets (EMS Morgen + EMS Vandaag)
Tijdlijn    ←──── NotificationManager
```

### Interfaces (A1)

Alle adapters implementeren smalle contracten uit `interfaces/`:

| Interface | Implementatie | Methoden |
|-----------|--------------|---------|
| `PowerSource` | HomeWizardAdapter, HomeyDeviceAdapter | `getPowerW()` |
| `ControllableBattery` | BatteryAdapter | `getSoc()`, `getPowerW()`, `setMode()` |
| `Charger` | EvChargeController | `getStatus()`, `enable()`, `setCurrentA()` |
| `Vehicle` | TeslaEvAdapter | `getSoc()`, `getRangeKm()`, `wake()` |
| `Thermostat` | ThermostatAdapter | `getMode()`, `setMode()` |

### Capability-map (A2/A3/A4)

`HomeyDeviceAdapter` werkt declaratief via een `CapabilityMap`:

```javascript
{ role: 'grid_meter', deviceId: '...', caps: {
    power:    'measure_power',
    power_l1: 'measure_power.phase_1',
    // A4 calc: net = import - export
    power: { calc: 'sub', sources: ['measure_power.import', 'measure_power.export'] }
}}
```

**A4 compositing patterns:**
- `calc` — afgeleid getal: `add`, `sub`, `scale`, `negate`
- `combined` — status uit drempel: `{ combined: 'threshold', source, threshold, above, below }`
- `sequence` — meerdere writes: `{ sequence: ['cap_a', 'cap_b'] }`

Nieuw apparaat/merk toevoegen = config in `DeviceProfiler.toCapabilityMap()`, geen nieuwe klasse.

---

## 3. Tekenconventie (B1)

**Bron:** `services/SignConvention.js` — één plek voor de definitie.

| Veld | Teken | Betekenis |
|------|-------|-----------|
| `pvW` | altijd `+` | Zonproductie (altijd ≥ 0) |
| `gridW` | `+` import / `−` export | Netafname (+) of teruglevering (−) |
| `batPowerW` | `+` ontladen / `−` laden | Accu geeft aan huis (+) of laadt (−) |
| `evW` | altijd `+` (magnitude) | EV trekt vermogen (richtingsloos) |
| `surplusW` | altijd `+` | `max(0, −gridW)` — export naar net |
| `deficitW` | altijd `+` | `max(0, +gridW)` — import van net |

---

## 4. Weersdata — Open-Meteo API

### Aanroep
```
GET https://api.open-meteo.com/v1/forecast
  ?hourly=temperature_2m,cloud_cover,shortwave_radiation,...
  &daily=temperature_2m_max,...
  &forecast_days=3
  &timezone={homey.clock.getTimezone()}   ← dynamisch, niet hardcoded
```

### Caching en retry
- Cache: 1 uur
- Bij fout: 2 pogingen (10s tussenpoze, timeout 15s)
- Fallback na 2 mislukkingen: vlakke curve (0 W/m²)
- Tijdzone: altijd van `homey.clock.getTimezone()` (werkt wereldwijd)

### PV-productiecurve
```
expectedKw = (radiationW / 1000) × peakKwp × 0.80
```
Per fase correctie (A3): als alle fasen hetzelfde piekuur hebben → simpele formule.
Anders → Gaussische herverdeling per fase.

---

## 5. Planningslogica

### Twee plannen naast elkaar

| Plan | Variabele | Doel |
|------|-----------|------|
| Vandaag | `_planToday` | Operationeel: stuurt EV/accu/WP realtime |
| Morgen | `_planTomorrow` | Preview: EMS Morgen widget |

### Herberekeningsschema

| Tijd | Target | Reden |
|------|--------|-------|
| 04:00 | today | Verse ochtendverwachting + nachtload berekend |
| 12:00 | today | Middag-update bewolking |
| 19:00 | tomorrow | Vroege avondplanning |
| 22:00 | tomorrow | Definitieve planning |
| Start app | today/tomorrow | Direct na herstart (netwerk ready na 30s) |
| EV inprikken | today/tomorrow | Plan herberekend met actuele SoC |

### Prioriteitsvolgorde

```
1. Huisverbruik            — altijd gedekt
2. Thuisaccu nachtreserve  — minimum wat de accu moet bewaren
3. EV laden (solar-first)  — alleen als zon surplus ≥ EV-drempel EN auto thuis
4. Thuisaccu bijladen      — resterende surplus
5. Warmtepomp offset       — per fase, bij surplus
6. Dump load               — als alles vol is
```

### EV thuis-check
```javascript
const evIsHome = settings.get(`ev_home_${['sun','mon',...][targetDate.getDay()]}`)
                 ?? (targetDate.getDay() === 0 || targetDate.getDay() === 6)
if (!evIsHome) evNeededKwh = 0;
```

---

## 6. EV Laadstrategie

### Laadmodi (B2)

| Waarde | UI naam | Gedrag |
|--------|---------|--------|
| `pv` | Solar only | Puur surplus, stop zodra `surplusW < 0` |
| `solar_only` | Solar+ | 5A min, stop bij `surplusW < −200W` (200W buffer) |
| `solar_and_grid` | Zon + net | Solar+ + nachtladen via plan |
| `fast_charge` | Snel laden | Max stroom altijd |
| `fixed` | Vast vermogen | Vaste stroom |
| `off` | Uit | — |

**Naamgeving:** "Solar only" = 100% zon, "Solar+" = zon plus een beetje marge.

### Real-time beslissing (strategie B)

```
surplusW = evLoadW − gridW − targetImportW

Start EV:  surplusW ≥ minPowerW (5A × fasen × 230V)
Stop EV:   surplusW < −200W  (Solar+)  of  surplusW < 0  (Solar only)
Stroom:    altijd vast op minCurrentA (standaard 5A)
```

### Tijd-hysterese (B3)

Schakelen pas na N opeenvolgende ticks met dezelfde surplus-conditie:

```
Surplus OK (3x): start_delay(1/3) → start_delay(2/3) → LADEN START
Surplus weg (3x): stop_delay(1/3) → stop_delay(2/3) → LADEN STOP
```

**Instellingen:** `ev_start_delay_ticks` (default 3 min), `ev_stop_delay_ticks` (default 3 min).

Reset bij: piekblok, postponed, voertuig weg/losgekoppeld.

### Min aan/uit-tijd (B4)

Na schakelen wordt de nieuwe toestand vergrendeld:

```
Na starten → min. 5 min laden (min_on_guard)
Na stoppen → min. 5 min wachten (min_off_guard)
```

**Instellingen:** `ev_min_on_min` (default 5), `ev_min_off_min` (default 5).

Werkt samen met B3: B3 voorkomt spurious switches, B4 vergrendelt na een legitieme switch.

### Piekblokken

Twee dagelijkse vensters waarbij EV-laden altijd geblokkeerd wordt (standaard 07:00-09:00 en 17:00-21:00). Uitzondering: rit-deadline dwingt fast_charge.

---

## 7. Battery Reserve

### Berekening

```
nightLoad    = gemiddelde huislast van laatste 3 nachten
               (zonsondergang → zonsopkomst, EV uitgesloten)

morningPeak  = huislast van zonsopkomst tot eerste solar-EV-startuur

batReserveKwh = nightLoad + morningPeak
```

### Nachtladen van accu

Als zon niet voldoende is voor EV:
```
batAvailableForEv = batCurrentKwh − batReserveKwh

1. EV laadt van accu (battery discharge)
2. Accu raakt reserve → battery naar idle
3. EV laadt verder van net
4. EV klaar → battery terug naar auto
```

---

## 8. Night Load / Day Load Tracking

- **night_load_YYYYMMDD**: totale huislast (kWh) van vorige nacht (lokale Amsterdam-tijd via `homey.clock.getTimezone()`)
- **day_load_YYYYMMDD**: array[24] met huislast per uur overdag
- Opslag: `actuals_YYYYMMDD_HH_S` (10-minuten slots, lokale tijdzone)
- Rolling gemiddelde: laatste 3 beschikbare dagen
- Valt terug op: 30% accucapaciteit (eerste dag, geen data)

---

## 9. Warmtepomp — Fase-bewuste Offset

```
Voor elke warmtepomp met toegewezen fase X:
  phaseGridW = gridPhases[X-1]

  Als phaseGridW < −drempel → surplus op fase X → setpoint omhoog
  Als phaseGridW >  drempel → tekort op fase X → setpoint omlaag
```

Daikin rate-limit bescherming: max 1 override-check per 10 minuten. Setpoint alleen gestuurd als het daadwerkelijk verandert.

---

## 10. Instellingen — Overzicht

### 🔌 Net & Aansluiting
P1 meter, fasen, max capaciteit, contracttype, tarieven/provider

### ☀️ Zonnepanelen
PV meter, piekvermogen per fase (L1/L2/L3), **piekuur per fase** (oriëntatie-correctie)

### 🔋 Thuisaccu
Apparaat, capaciteit, max laad/ontlaadvermogen

### 🚗 Elektrische auto

| Instelling | Default | Beschrijving |
|------------|---------|-------------|
| Laadmodus | Solar+ | Solar only / Solar+ / Zon+net / Vast / Snel / Uit |
| Min laadstroom (A) | 5 | Start-drempel strategie B |
| Max laadstroom (A) | 16 | Plafond bij snel laden |
| Netbuffer (W) | 100 | Kleine import-tolerantie bij asymmetrie |
| Start-vertraging (min) | 3 | B3: ticks vereist voor starten |
| Stop-vertraging (min) | 3 | B3: ticks vereist voor stoppen |
| Min. laadtijd (min) | 5 | B4: min. aan-tijd na starten |
| Min. wachttijd (min) | 5 | B4: min. uit-tijd na stoppen |
| Piekuren ochtend | 07-09 | EV geblokkeerd |
| Piekuren avond | 17-21 | EV geblokkeerd |
| Uitstelduur (min) | 30 | Belastingsbalancering flow |
| 's Nachts laden | uit | Nachtvenster netlading |
| Auto staat thuis op | Za+Zo | Thuisdag-check voor planning |

### 🌡️ Warmtepomp
Tot 3 warmtepompen elk met fase-toewijzing (L1/L2/L3/alle), temperatuur offset

### ⚙️ EMS Gedrag
Overschot drempel (W)

---

## 11. Dashboard Widgets

### Beide widgets: zelfde formaat
Tegeltjes (zon/net/accu/EV) + grafiek + footer

### Widget 1 — EMS Morgen (altijd MORGEN)
- Tegeltjes: kWh zon, kWh EV, kWh accu, **kWh verbruik**, badge haalbaar/krap
- Grafiek: stippellijnen = plan (zon-parabool, verbruik rood, EV-blok, accu-curves)
- Databron: `planningEngine._planTomorrow`

### Widget 2 — EMS Vandaag (altijd VANDAAG)
- Tegeltjes: live W (zon/net/accu/EV), EV toont dagtotaal kWh als niet aan het laden
- Grafiek: stippellijnen = forecast vandaag, solid = actuals (10-min resolutie)
- Databron: actuals via `getActuals`, forecast via `getTodayPlan`

---

## 12. Notificaties

| Gebeurtenis | Bericht | Wanneer |
|-------------|---------|---------|
| Plan berekend | ✅/⚠️ Plan [dag]: X kWh zon, Y kWh EV | Alleen geplande recalcs |
| Plan krap | ⚠️ Dagplan krap | prio1NotFeasible |
| EV gestart | 🚗 EV laden gestart — XXXW (via EMS / eigen schema) | Bij start |
| EV gestopt | 🔌 EV laden gestopt — X.X kWh | Bij stop |
| Reserve bereikt | 🔋 Accu reserve bereikt — EV op net | Bij switch |
| WP omgeschakeld | 🌡️ Warmtepomp → koelen/verwarmen | Bij mode switch |
| EV klaar | ✅ EV klaar voor vertrek — XX% | evReadyForDeparture |
| Accu laag | 🔋 Thuisaccu onder minimum — XX% | batteryBelowMinimum |
| Weersdata fout | ❌ Weersdata mislukt na 2 pogingen | Na 2 retries |

---

## 13. Vehicle Cache (B5)

`TeslaEvAdapter._getTeslaAppState()` heeft een 10-minuten cache voor SoC/range:
- Voorkomt onnodige Tesla cloud-polls via de Homey Tesla app
- Cache wordt direct leeggemaakt bij charging-transitions (start/stop)
- Stale cache wordt teruggegeven bij API-fouten (fail-safe)

---

## 14. Toetsing nieuwe functionaliteit

Bij elke nieuwe feature, check:

1. **Tekenconventie (B1):** gebruikt `surplusW`/`deficitW` correct (altijd ≥ 0)?
2. **Prioriteitsvolgorde:** klopt de volgorde huis → reserve → EV → accu → WP → dump?
3. **Solar-first:** EV laadt nooit meer dan zon oplevert tenzij nachtlading gepland
4. **Widget-scheiding:** EMS Morgen = altijd morgen, EMS Vandaag = altijd vandaag
5. **Notificatie-spam:** geen meldingen bij handmatige acties
6. **Accu-reserve:** `batReserveKwh` gerespecteerd bij nieuwe ontlaad-logica
7. **Thuisdag-check:** geldt nieuwe logica ook niet als auto er niet is?
8. **Hysterese-reset:** nieuwe schakelcondities de `_resetHysteresis()` aanroepen?
9. **Tijdzone:** geen `toISOString()` of `getHours()` zonder `homey.clock.getTimezone()`
10. **Interface-contract:** nieuwe adapter implementeert de juiste interface uit `interfaces/`?

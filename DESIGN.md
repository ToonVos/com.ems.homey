# HEMS — Ontwerpdocument

## Dashboard Widgets

### Twee widgets, twee verantwoordelijkheden

| Widget | Naam | Toont | Bron |
|--------|------|-------|------|
| 1 | **EMS Morgen** | Plan voor MORGEN (altijd de volgende dag) | `planningEngine._planTomorrow` |
| 2 | **EMS Vandaag** | Actuals vandaag + voorspelling vandaag als overlay | `actuals[]` + `planningEngine._planToday` |

**Beide widgets hebben hetzelfde formaat:**
- 4 tegeltjes bovenaan als legenda met totalen: ☀️ Zon · ⚡ Net · 🔋 Accu · 🚗 EV
- Grafiek eronder, zelfde schaal, zelfde kleuren

---

### Widget 1 — EMS Morgen (altijd MORGEN)

**Tegeltjes:**
- ☀️ Zon: verwachte totale productie morgen (kWh)
- 🔋 Accu: beschikbare accucapaciteit (kWh)
- 🚗 EV: benodigde kWh voor EV morgen (0 als auto niet thuis)
- ✅/⚠️ badge: plan haalbaar / krap

**Grafiek (stippellijnen = voorspelling):**
- 🟢 Groen gestippeld + vlak: verwachte zonproductie (parabool)
- 🟠 Oranje gestippeld blok: geplande EV-laadperiode (binnen zon-parabool, = surplus na verbruik)
- 🟡 Geel gestippeld: geplande accubelading (volgt de stijgende zoncurve)
- 🔴 Rood gestippeld: verwacht huisverbruik (dashed, altijd zichtbaar)
- 🟡 Rechter as gestippeld: verwachte accu-SoC loop

**Planninglogica (zie sectie Planning Engine):**
- EV-blok toont alleen als auto thuis is op die dag
- EV-blok staat BINNEN de zon-parabool (= surplus ná verbruik, niet het volle laadvermogen)
- Accu laadt op de stijgende flank vóór EV start

---

### Widget 2 — EMS Vandaag (altijd VANDAAG)

**Tegeltjes (live waarden):**
- ☀️ Zon: huidige productie (W)
- ⚡ Net: import (↓ rood) / export (↑ groen)
- 🔋 Accu: huidig vermogen + SoC %
- 🚗 EV: laadvermogen of "–"

**Grafiek:**
- Stippellijnen = voorspelling van vandaag (zelfde kleuren als EMS Morgen)
- Solid vlakken = werkelijke gemeten actuals (10-minuten resolutie)
- Actuals "overschrijven" de stippellijnen naarmate de dag vordert
- Stippellijnen lopen door voor uren die nog niet gemeten zijn (toekomst zichtbaar)

**Kleuren actuals:**
- 🟢 Groen vlak: gemeten zonproductie
- 🟣 Paars vlak: netto-import van het net
- 🟦 Blauw-groen dashed: netto-export naar net
- 🟠 Oranje vlak: EV-laden gemeten
- 🟡 Geel vlak: accu lading gemeten

---

## Planning Engine

### Twee plannen naast elkaar

```
_planToday:    plan voor vandaag (operationeel — stuurt EV/accu realtime)
_planTomorrow: plan voor morgen  (preview — toont EMS Morgen widget)
```

**Herberekeningsschema:**

| Tijd  | Target   | Doel |
|-------|----------|------|
| 04:00 | today    | Verse ochtenddata voor vandaag |
| 12:00 | today    | Middag-update vandaag |
| 19:00 | tomorrow | Vroege avondplanning morgen |
| 22:00 | tomorrow | Definitief plan morgen |
| start | today/tomorrow | Direct na herstart (netwerk ready na 30s) |

### Prioriteitsvolgorde

1. **Huisverbruik** (altijd gedekt)
2. **Thuisaccu nachtreserve** = night_load + morning_peak (dynamisch berekend)
3. **EV laden** — alleen als:
   - Auto is thuis op die dag (thuisdag-checkboxes)
   - Surplus ≥ EV minimumvermogen (5A × fasen × 230V)
   - Niet in piekblok (07:00-09:00 of 17:00-21:00)
4. **Warmtepomp offset** (per fase, alleen als surplus op die fase)
5. **Dump load** (alles wat overblijft)

### EV Laadlogica (strategie B)

- **Start**: surplus > 3450W (5A × 3 fase × 230V) → EV aan op 5A VAST
- **Stop**: surplus < -200W → EV uit
- **Geen dynamisch rampen** — accu absorbeert variaties
- **Nachtladen van accu**: als zon niet voldoende is voor EV:
  - Accu levert aan EV totdat reserve bereikt is
  - Reserve = night_load + morning_peak (rolling 3-daags gemiddelde)
  - EV gaat daarna verder op net
  - Accu hervat na EV-sessie

### Battery Reserve Berekening

```
night_load   = gemiddelde van laatste 3 nachten
               (huisverbruik zonsondergang → zonsopkomst, EV uitgesloten)

morning_peak = huisverbruik van zonsopkomst tot eerste solar-EV-start uur
               (het uur waar zon - verbruik ≥ EV-minimumvermogen)

batReserveKwh = night_load + morning_peak
```

---

## Night Load / Day Load Tracking

- **night_load_YYYYMMDD**: totale huislast (kWh) van vorige nacht
- **day_load_YYYYMMDD**: array[24] met huislast per uur overdag
- Opslag via: `actuals_YYYYMMDD_HH_S` (10-minuten slots)
- Rolling gemiddelde: laatste 3 beschikbare dagen
- Valt terug op: 30% accucapaciteit (eerste dag, geen data)

---

## Notificaties (Homey tijdlijn)

| Trigger | Bericht | Wanneer |
|---------|---------|---------|
| Plan berekend | ✅/⚠️ Plan [datum]: X kWh zon, Y kWh EV — haalbaar/krap | Alleen geplande recalcs |
| EV gestart | 🚗 EV laden gestart — XXXW | Bij start |
| EV gestopt | 🔌 EV laden gestopt — X.X kWh | Bij stop |
| Reserve bereikt | 🔋 Accu reserve bereikt — EV op net | Bij switch |
| Plan krap | ⚠️ Dagplan krap — onvoldoende zon | Bij prio1NotFeasible |
| WP omgeschakeld | 🌡️ Warmtepomp → koelen/verwarmen | Bij mode switch |
| Weersdata fout | ❌ Weersdata mislukt na 2 pogingen | Na 2 retries |

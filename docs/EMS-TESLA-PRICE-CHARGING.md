# Tesla prijs-gestuurd laden — geïmplementeerde regie

Deze fork voegt aan Menno's EMS een **prijs-gestuurde Tesla-laadregie** toe voor een
dynamisch EPEX-contract. Onder saldering (tot 1‑1‑2027) geldt: export ≈ import (1:1
verrekend), dus zelfverbruik-optimalisatie heeft geen waarde — de énige kostenknop is
*wanneer* je je netto-import koopt. De Tesla is de grote flexibele last → het laden
wordt naar de goedkoopste uren geschoven, tot een doel-SoC op een deadline.

Menno's zon-volgende logica (`solar_only`, `solar_and_grid`, `fixed`, `fast_charge`,
`off`) blijft volledig intact; dit is een **nieuwe laadmodus** ernaast: **`price`**.

## Componenten

| Bestand | Rol |
|---|---|
| `services/TeslaScheduler.js` | Beslis-engine (60s): kiest goedkoopste uren tot deadline, stuurt de auto, verifieert. |
| `services/PricePredictor.js` | Prijs-horizon: EpexPredictor 168u (forecast) + EnergyZero-actuals (vandaag+morgen). |
| `services/DayAheadPrices.js` | Menno's dagplan-prijzen; provider `energyzero`/`pbth`/`entso-e`/`tibber`. |
| `widgets/ems-control/` | Dashboard-tegel "EMS Tesla-doel": %-keuze + datum/tijd-deadline + live status. |
| `services/DecisionLog.js` | Debug-/tuning-laag: snapshots, retentie, week-rapport. |
| `devices/EvChargeController.js` | Haakt af bij modus `price` (geen dubbele sturing). |

## Beslissing per cyclus (TeslaScheduler)

Actief alleen bij **laadmodus `price`** én **dynamisch contract**. Per 60s:

1. **Auto-toestand** uitlezen (SoC, verbonden, laadt).
2. **Doel bepalen:** override (dashboard-tegel) of standaard-doel (`ev_default_soc`) op de
   eerstvolgende standaard klaar-tijd (`ev_default_deadline`, default 07:00).
3. **Prijs-horizon** ophalen (zie hieronder).
4. **Slot-selectie in twee lagen:**
   - *Verplicht:* goedkoopste 15-min-slots in `[nu, deadline]` om het doel te halen.
   - *Opportunistisch:* goedkoopste slots in de **hele 7-daagse horizon** om van doel →
     plafond (`ev_opportunistic_soc`, max 85%) te gaan — **hooguit 1× per week**
     (7‑daagse lockout na bereiken). Geen prijsdrempel: het reserveert simpelweg de
     goedkoopste uren die het nodig heeft (weekenddalen worden vanzelf gepakt).
5. **Laad nu?** = huidig slot ∈ selectie · OR SoC ≤ bodem (PANIC) · OR (deadline voorbij
   && doel niet gehaald → doorladen; SoC-garantie wint van tijd).
6. **Sturen** (live) of alleen loggen (proef), met idle-skip op ongewijzigde wens.
7. **Verifiëren:** 3 min na een commando wordt de werkelijke laadtoestand gelezen; klopt
   die niet → `car_wake_up` + opnieuw sturen (max 2×), daarna notificatie.

### Batterijgezondheid-bewaking (`ev_battery_health`, default aan)
Houdt de NCA-pack langer goed door hoge SoC niet lang vast te houden. Per band ander venster:
- **0–80%:** goedkoopste uren tot de deadline.
- **80–90%:** alleen goedkope uren **≤6u vóór** de klaar-tijd.
- **90–100%:** pas op het **laatste moment** vóór de klaar-tijd.

Uit = puur de goedkoopste uren, ongeacht niveau.

## Prijs-horizon (PricePredictor)

Eén horizon op 15-min resolutie, all-in (`kale × 1,21 + €0,13085`), in voorkeursvolgorde:

1. **EnergyZero** (provider `energyzero`, geen API-key) — échte uurprijzen voor **heel
   vandaag + morgen** (na ~13:00 gepubliceerd). Cache 1u.
2. **PbtH-overlay** (fallback) — de eerstvolgende **8 uur** uit `meter_price_h0..h7` van
   het Stroomprijzen-device. (PbtH publiceert niet méér uren als capabilities.)
3. **EpexPredictor** 168u (b3nn0/Batzill) — forecast voor dag 3–7 (MAE ~1,7 ct/kWh).

De **7-daagse voorspeller is gekoppeld aan het dynamische contract**: bij vast tarief
bestaat "goedkoopste uur" niet → niet ophalen, prijs-modus verborgen.

## Sturing zonder handmatige flows

De scheduler roept de **device-flow-acties van de Tesla-app rechtstreeks** aan via
`runFlowCardAction` (geen door de gebruiker gekoppelde flow nodig):
`charge_limit` (50–100), `charge_current` (0–32A), `charging_on` ({start,stop}),
`car_wake_up` ({wait}). Command-zuinig: limiet/amps alleen bij wijziging, start/stop alleen
op transitie.

De **laadsnelheid-observer** meet tijdens het laden de echte ΔSoC/tijd (EWMA in
`tesla_observed_kwh_per_h`) en gebruikt dat voor "hoeveel uren nodig"; tot er data is
rekent hij met het berekende vermogen (amps × fasen × 230V).

## Instellingen (Elektrische auto → modus "💶 Prijs")

| Setting | Default | Betekenis |
|---|---|---|
| `ev_charge_mode` | — | `price` activeert deze regie |
| `ev_capacity_kwh` | 75 | accu-capaciteit |
| `ev_default_soc` | 70 | standaard-doel zonder override |
| `ev_default_deadline` | 07:00 | standaard klaar-tijd |
| `ev_floor_soc` | 20 | bodem/panic — hieronder direct laden |
| `ev_opportunistic_soc` | 85 | opportunistisch plafond (max 85), 1×/week |
| `ev_battery_health` | aan | bandgewijze timing voor hoge SoC |
| `ev_max_current_a` | 16 | laadvermogen-plafond |
| `tesla_scheduler_mode` | live | `live` stuurt echt, `dryrun` rekent/logt |
| `day_ahead_provider` | — | `energyzero` aanbevolen |

Doel-% en deadline overschrijf je live via de **dashboard-tegel "EMS Tesla-doel"**.

## Debug-/tuning-laag (DecisionLog)

Om de app te blijven tunen:
- Elke 5-min snapshot bevat sensoren + prijzen + de **actuele scheduler-beslissing**
  (gecorreleerd) → `/userdata/decisionlog-YYYYMMDD.jsonl`.
- Fijnere scheduler-log (60s) → `/userdata/teslasched-YYYYMMDD.jsonl`.
- **Retentie:** logs ouder dan `debug_retention_days` (default 7) worden dagelijks
  opgeruimd — de log loopt niet eindeloos door.
- **Week-rapport:** knop "📊 Week-rapport" in Diagnostics + `/userdata/tuning-summary.json`
  (dagelijks). Toont o.a. geschat kWh geladen, betaalde vs marktprijs + besparing%,
  verplicht/opportunistisch slots, commando's, wake-retries, SoC-bereik, beslissingen.

## Veiligheid / vangrails

- Alleen actief in modus `price` + dynamisch contract; anders volledig stil.
- Nexus blijft **read-only** (autonome handelaar; module 1).
- Bodem-SoC (panic), idle-skip, command-discipline en de verificatie+wake-lus voorkomen
  weglopende commando's en lege accu.
- `dryrun`-stand om eerst te observeren zonder te sturen.

## Sturing & robuustheid (v1.7 — uit live gebruik)

Tesla-commando's vergen een wakkere auto; een **slapende, ingeplugde Tesla laadt tóch
door tot z'n eigen limiet**, en losse start/stop-commando's falen dan met
`could_not_wake_buses`. Daarom:

- **Laadlimiet = ons doel als hoofd-stop.** De scheduler zet `charge_limit` op het
  actuele stop-punt (verplicht doel / plafond / huidige SoC) — de auto stopt dan
  **zelf**, ook slapend ladend. Start/stop (`charging_on`-capability) is secundair, voor
  de timing.
- **Reconcile elke cyclus:** vergelijk gewenst vs werkelijk laden en stuur bij tot het
  klopt (niet alleen op een eigen toestand-wissel).
- **Wake-bewust + credit-veilig:** `car_state` is **gratis** te checken; pas dán wekken
  (wake = $0,02 = 20× een commando; commando $0,001; data $0,002 — $10/maand gratis per
  Tesla-account). Backoff na een mislukt commando, opgeven + melden na enkele pogingen.

## Laadmodi

| Modus | Wanneer | Gedrag |
|---|---|---|
| `price` | **pre-saldering** (nu) | Verplicht doel via goedkoopste uren tot deadline; opportunistisch tot plafond (≤85%, 1×/week) via de goedkoopste week-uren. |
| `surplus` | **post-saldering** | Gecombineerd (`_tickCombi`): verplicht doel via goedkoopste uren **of gratis overschot**; daarboven (→plafond) **uitsluitend** op zonne-overschot, geen netinkoop. Behoudend (aanhoudend overschot, min aan/uit, amp-hysterese — wear-veilig). |
| Menno's `solar_*`/`fixed`/`off` | — | Onaangeroerd; EvController haakt af bij `price`/`surplus`. |

## Tijdlijn-meldingen

`NotificationManager` met **categorieën** (`plan`, `battery`, `session`, `ev`, `heatpump`,
`tesla`, `errors`) — per groep aan/uit via settings `notify_<cat>` (instellingen-kaart
"🔔 Meldingen"). **Standaard alles uit** (rustige tijdlijn). Ontdubbeling: identieke
melding hooguit 1×/30 min.

## Diagnose-API (api.js)

`getTeslaScheduler` (ring), `getTuningReport` (week-samenvatting), `getUserdataFile`
(lees `/userdata`-logs) — voor terugwerkende analyse.

> Ontwerp & rationale: zie de brein-repo `ems-homey` (`docs/ARCHITECTURE.md`,
> `tasks/phase-3/3.4-fork-implementatieplan.md`).

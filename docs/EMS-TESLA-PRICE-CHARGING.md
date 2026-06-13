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
7. **Verifiëren:** elke cyclus wordt de werkelijke laadtoestand (Tesla-boolean) vergeleken
   met de wens; klopt het niet → eerst zacht herproberen, ~1 min later wake-en-online-wachten
   + opnieuw sturen (escalatie tot enkele pogingen), daarna notificatie. Zie "Sturing &
   robuustheid (v1.8)" hieronder.

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

## Sturing (capabilities + trigger-bruggen)

Een Homey-**app kan géén flow-acties van een ander device draaien**: `runFlowCardAction`
vereist scope `homey.flow`, die een app niet krijgt → **"Missing Scopes"**. Settable
capabilities (scope `homey.device.control`) werken wél. Daarom (v1.9.1):

- **Start/stop laden** → settable capability `charging_on` (betrouwbaar, direct).
- **Wekken** → settable capability `car_wake_up` (boolean). (Vóór v1.9.1 ging dit via de
  flow-actie en faalde het stil → de auto kwam vroeger "vanzelf" online.)
- **Laadlimiet** (`charge_limit`, 50–100) en **laadstroom** (`charge_current`, 0–32A) hebben
  **geen** settable capability → via een **trigger-brug**: de scheduler `emit`'t
  `ems:setEvChargeLimit` / `ems:setEvChargeCurrent`; de gebruiker koppelt die éénmalig aan de
  Tesla-acties "Stel Laadlimiet SoC in" / "Stel laadstroom in". (Het limiet-arg is type
  `range`/schuifbalk → token niet kiesbaar in de flow-editor; de flow is via de API met
  `"limit":"[[limit]]"` aangemaakt en werkt at runtime.)

Command-zuinig: limiet/amps alleen bij wijziging, start/stop alleen op transitie.

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
| `ev_vacation_soc` | 55 | **Spaarstand**: rustniveau bij verre deadline / lang stilstaan |
| `ev_battery_health` | aan | bandgewijze timing voor hoge SoC |
| `ev_max_current_a` | 16 | laadvermogen-plafond |
| `tesla_scheduler_mode` | live | `live` stuurt echt, `dryrun` rekent/logt |
| `day_ahead_provider` | — | `energyzero` aanbevolen |
| `debug_retention_days` | 30 | hoeveel dagen logs bewaard worden |

Doel-% en deadline overschrijf je live via de **dashboard-tegel "EMS Tesla-doel"**.

### Verre deadline → Spaarstand (ARCHITECTURE v5.7)
Een deadline mag willekeurig ver vooruit. Zolang die **>168u** weg is, houdt de scheduler
de **Spaarstand** aan (`ev_vacation_soc`, default 55% — accu-vriendelijk, géén
opportunistische top-up). Zodra de deadline **≤168u** nadert, schopt de normale planning
aan en laadt hij in de goedkoopste uren naar het gekozen doel.

### Accu-vriendelijke SoC-niveaus (onderbouwd, NCA-pack)
Kalender-veroudering domineert en loopt sterk op boven ~55% SoC; ≤55% remt slijtage het
sterkst, <20% is een kritieke ondergrens. Vertaald naar de app:
**20% bodem · 55% spaarstand · 60% dagelijks · 85% kort/1×-week · laatste 10% pas vlak
vóór vertrek.**

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

- **Laadlimiet = hoofdsturing (v1.9.2).** De scheduler zet `charge_limit` op het **doel** (`capPct`):
  bewaarstand 55% bij een **verre** deadline (>1 week), anders jouw target. De auto stopt **zelf** op
  de limiet, ook slapend ladend. We **laden ALLEEN in de door de planner gekozen goedkoopste slots**
  richting het doel: `want2 = reached || (soc < capPct && chargeNow)` met `reached = soc ≥ capPct−1`.
  Aankoppelen in een duur uur → **STOP** wat de Tesla zelf start, en wachten op een goedkoop slot.
  Zodra het doel bereikt is = **"rust"**: laden blijft aan op de limiet en de Tesla houdt het zelf bij
  (slaapt, minimale drain) — geen stop, geen herhaalde start (`carMaintaining`, churn opgelost).
  Bewaarstand-recharge gebeurt in de goedkoopste uren binnen een **vast 24u-venster ná het
  aankoppelen** (`ev_hold_horizon_h`, deadline = `pluggedSince+24u`, niet perpetueel rollend);
  **binnen de week is er géén 55%-tussenstap**. Split binnen de laad-fase nog via
  `charging_on` start/stop (limiet blijft op het doel). Gemiste stop → hooguit tot het doel, nooit 82%.
  Decision-label `rust` (op niveau, laden aan).
- **Reconcile elke cyclus:** vergelijk gewenst vs werkelijk laden en stuur bij tot het
  klopt (niet alleen op een eigen toestand-wissel).
- **Wake-bewust + credit-veilig:** `car_state` is **gratis** te checken; pas dán wekken
  (wake = $0,02 = 20× een commando; commando $0,001; data $0,002 — $10/maand gratis per
  Tesla-account). Backoff na een mislukt commando, opgeven + melden na enkele pogingen.

## Sturing & robuustheid (v1.8 — gerijpt op echte data)

Uit live-tests in juni 2026 bleek dat de datavoorziening, niet de logica, de bottleneck was.
Aangescherpt (volledige rationale: brein-repo `tasks/design/d07-laadtijd-leermodel.md` + `tasks/lessons.md`):

- **Laad-detectie = de Tesla-boolean.** "Laadt hij?" komt uit `charging_on`/`charging_state`
  van de auto, **niet** uit `measure_charge_power` — die kan in beide richtingen stale zijn
  (10 kW terwijl charging_on=false; of 3 kW blijven hangen ná de stop → ten onrechte een wake).
  De oude 10-min adapter-cache is verwijderd: capability-reads zijn gratis en altijd vers.
- **Home-gate:** alleen sturen als de auto **thuis** is. **DC-snelladen** (`measure_charge_power_dc>0`,
  Supercharger) = onderweg → handen af, zodat onderweg-laden tot je gekozen waarde blijft werken.
- **NoPower (rode kabel):** `charging_state='NoPower'` = kabel ingeplugd maar geen stroom op de
  kabel (laadpunt uit). Dan **niet** sturen (zinloos) maar **éénmalig waarschuwen** + in de widget tonen.
- **Wake-discipline:** na `car_wake_up` **wachten tot `car_state='online'`** vóór een commando
  (anders `could_not_wake_buses` + extra wake). Bij een START van een slapende auto meteen wekken;
  bij een gepland slot de wake **vooruit** plaatsen zodat het laden op tijd begint. Stop = eerst zacht,
  ~1 min later kijken, dan wake + hard stoppen; limiet-fail-safe richting huidige SoC.
- **Lerend laadtijd-model:** `tijd = wake + overhead + ΔSoC·min_per_procent(temp)`. Snelheid geleerd
  per `module_temp`-bucket (winter trager), overhead per sessie, wektijd. Priors = oude aanname →
  identiek bij nul data, daarna zelf-verbeterend.
- **Aaneengesloten-bewuste slot-keuze:** minimaliseert `Σ energieprijs + n_sessies × C_session`
  (`ev_session_cost_eur`, €0.10). Doorladen waar goedkope uren aansluiten; splitsen alleen om een
  dure tussenpiek als de besparing > sessie-kosten.

## Laadmodi

| Modus | Wanneer | Gedrag |
|---|---|---|
| `price` | **pre-saldering** (nu) | Verplicht doel via goedkoopste uren tot deadline; opportunistisch tot plafond (≤85%, 1×/week) via de goedkoopste week-uren. |
| `surplus` | **post-saldering** | Gecombineerd (`_tickCombi`): verplicht doel via goedkoopste uren **of gratis overschot**; daarboven (→plafond) **uitsluitend** op zonne-overschot, geen netinkoop. Behoudend (aanhoudend overschot, min aan/uit, amp-hysterese — wear-veilig). |
| Menno's `solar_*`/`fixed`/`off` | — | Onaangeroerd; EvController haakt af bij `price`/`surplus`. |

## Energie-boekhouding & Homey Energy (v1.9)

- **`services/EnergyLedger.js`** (observe-only): dagelijkse energie-boekhouding. **Bruto**
  dag-import/export uit de aparte fiscale-P1-registers (`meter_power.imported`/`exported`)
  via middernacht-snapshot — géén saldering; `partial`-vlag tot de eerste volledige dag.
  Zon/accu/handel uit full-day device-tellers; verbruik uit de sluitende balans
  (`pv + grid + accu`); **huishouden = verbruik − EV**. €-waardering tegen instelbare
  prijs-componenten (zie hieronder), op **post-saldering (2027)**-basis (beslis-simulatie).
  Endpoint `getEnergyLedger`; JSONL `/userdata/energy-ledger.jsonl`.
- **Prijs-componenten instelbaar** (instellingen → Dynamisch contract): `price_energy_tax_eur`
  (€0,1108), `price_supplier_fee_eur` (€0,0199892), `price_btw_factor` (1,21),
  `price_export_bonus_eur` (0,02), `price_export_factor` (1,10), `ev_session_cost_eur` (0,10).
  Import = `kale × btw + belasting + opslag`; export = `(kale + bonus) × factor`.
- **`drivers/ev-charger`** (class `evcharger`): "Tesla thuislading" — voedt het
  thuislaadvermogen (uit de scheduler, gegate op de Tesla-boolean; DC/onderweg uitgesloten)
  + cumulatieve `meter_power` aan **Homey Energy**. Daardoor toont Energy de EV-laadbeurt en
  wordt "Overig" het échte huishouden, zonder dubbeltelling (P1 = cumulatieve grid-referentie).
- **`toon_fasen`-setting** (default uit): verbergt de per-fase-tiles (`pv_l1..`/`grid_l1..`) —
  er is geen echte per-fase data (PV-totaal-only; P1 alleen L1).
- **NoPower-flow-triggers**: `ev_no_power` / `ev_power_restored` (rode kabel / laadpunt uit).
- Vereist Homey **≥12.4.5** (evcharger-capabilities).

## Tijdlijn-meldingen

`NotificationManager` met **categorieën** (`plan`, `battery`, `session`, `ev`, `heatpump`,
`tesla`, `errors`) — per groep aan/uit via settings `notify_<cat>` (instellingen-kaart
"🔔 Meldingen"). **Standaard alles uit** (rustige tijdlijn). Ontdubbeling: identieke
melding hooguit 1×/30 min.

## Diagnose-API (api.js)

`getTeslaScheduler` (ring met beslissingen incl. `car_state`/`charge_power_kw`/`no_power`/
`away_dc`/`wake_secs`), `getTeslaStateLog` (Tesla state-changes + live snapshot),
`getTeslaLearn` (geleerde snelheid per temp-bucket, overhead, wektijd + laatste sessies),
`getEnergyLedger` (dag-boekhouding: verbruik/huishouden/EV/zon/import/export/handel + RTE),
`getTuningReport` (week-samenvatting), `getUserdataFile` (lees `/userdata`-logs:
`teslasched-*.jsonl`, `tesla-statelog-*.jsonl`, `tesla-sessions.jsonl`) — voor terugwerkende analyse.

> Ontwerp & rationale: zie de brein-repo `ems-homey` (`docs/ARCHITECTURE.md`,
> `tasks/phase-3/3.4-fork-implementatieplan.md`).

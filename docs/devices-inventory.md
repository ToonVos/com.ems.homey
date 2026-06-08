# Devices inventory — EMS-bron-mapping (Homey "Homey Pro van Toon")

Koppeltabel: welke Homey-device + capability levert welke EMS-input. Uitgelezen via
`homey api devices get-devices --json` op 2026-06-08. Device-ID's zijn stabiel per Homey.

> Twee lagen: **rauwe device-apps** (live waarden + sturing) en **Power-by-the-Hour**
> (gruijter) bovenop voor prijzen, solar-forecast en kosten-tracking (`Σ`-counters).

## Bron-mapping

| EMS-input | Device | id | app (driverUri) | Sleutel-capabilities |
|---|---|---|---|---|
| **Live net (P1)** | LS120P1_192.168.1.29 | `ec398f63-5125-49d2-95aa-94b822d055b6` | `com.gruijter.enelogic:LS120` | `measure_power` (instantaan), `measure_power.l1`, `measure_current.l1`, `meter_power.imported`, `meter_power.exported` |
| **Live PV** | envoy (122318008761) | `ef2cb7fc-ce4c-4235-828b-99eb7cdb091a` | `it.diederik.solar:enphase-envoy-v7` | `measure_power`, `measure_power.grid`, `measure_power.consumption`, `meter_power` |
| **Auto-status + wake** | Tesla S | `37cdaf85-28d4-41ca-95fb-7591764aa597` | `com.tesla.car:car` | `measure_battery`, `ev_charging_state`, `car_state`, `car_wake_up`, `car_refresh`, `car_sentry_mode`, `meter_car_odo`, `alarm_api_error`, `measure_api_request_count`, `measure_api_command_count`, `measure_api_command_wakes_count`, `measure_api_costs` |
| **Auto-laadsturing** | Tesla S batterij | `d2ffa0cf-3b76-4185-9185-aee51364ce27` | `com.tesla.car:battery` | `charging_on`, `charging_state`, `measure_charge_current`, `measure_charge_current_max`, `measure_charge_limit_soc`, `measure_charge_power`, `measure_charge_power_ac`, `measure_soc_level`, `measure_soc_usable`, `measure_charge_energy_added`, `module_temp` (pack-temp), `charging_port`, `charging_port_unlock` |
| **Nexus (Powerplay)** | Zonneplan Batterij | `b3000657-38f3-4079-b309-074d0bc6edd1` | `nl.zonneplan:battery` | `measure_power`, `measure_battery`, `battery_charging_state`, `control_mode`, `cycle_count`, `meter_power.import/export`, `meter_power.daily_earned`, `meter_power.total_earned`, `boolean.*` (NIET aansturen — alleen lezen, P2) |
| **Prijzen (EPEX, all-in?)** | Stroomprijzen | `cc19fcf6-8f6f-4174-8f9b-6163b630f360` | `com.gruijter.powerhour:dap` | `meter_price_h0..h7`, `meter_price_h0_export`, `meter_price_next_day_lowest/highest/avg`, `hour_*_lowest/highest`, `meter_rank_price_h0_this_day` |
| **Solar-forecast** | Zonne voorspeller envoy | `0f81e2c1-ccbd-4748-8862-a66d0d0c9acb` | `com.gruijter.powerhour:solar` | `measure_watt_forecast.h0/m15/m30/m45/h1/h2/h3`, `measure_watt_forecast.tomorrow_peak`, `meter_kwh_forecast.this_day/tomorrow`, `measure_solar_use.*` |
| **Kosten-tracking PV** | envoy …_Σpower | `444e54c6-b933-4b37-bb2b-0be9a7a581ea` | `com.gruijter.powerhour:power` | money-meters (rapportage) |
| **Kosten-tracking net** | LS120P1 …_Σpower | `99d12595-e6b7-4cea-bd5b-8ff67acfc739` | `com.gruijter.powerhour:power` | `measure_watt_avg`, money-meters |

## Implicaties voor de modules

- **Module 2 (Tesla zonder Wall Connector):** opgelost via `Tesla S batterij` — `charging_on` + laadstroom + `measure_charge_limit_soc` (action cards) sturen het laden zonder Wall Connector. Wake via `Tesla S` → `car_wake_up`. Geen eigen Fleet-adapter nodig; Menno's `EvChargeController` op dit device laten wijzen + command-budget eromheen.
- **Command-budget:** `Tesla S` exposeert `measure_api_request_count` / `measure_api_command_count` / `measure_api_costs` / `measure_api_command_wakes_count` — alleen uitlezen + bewaken, niet zelf tellen.
- **Li-plating <0°C (LOCKED L5):** gebruik `module_temp` van `Tesla S batterij` (echte pack-temp), niet omgevingstemp.
- **Module 3 (all-in prijs):** `Stroomprijzen` levert mogelijk al all-in prijzen (`meter_price_h0` ≈ €0,224 incl. belasting) + aparte `_export`. Verifiëren of PbtH-markup correct staat → mogelijk verkleint dit module 3 tot "lees PbtH all-in" i.p.v. zelf rekenen.
- **Live grid/PV:** gebruik de **rauwe** devices (`measure_power`), niet de `Σ`-counters (die geven `measure_watt_avg`, te traag voor zero-export sturing).
- **Nexus:** alleen lezen. `control_mode=dynamic_charging`, `total_earned` = Powerplay-opbrengst (lifetime €2417 op 2026-06-08).

## Aansturing (flow-cards) — uitgelezen 2026-06-08

Flow-cards zijn device-scoped (`homey:device:<id>:<card>`). Een Homey-app kan ze
aanroepen via de Flow-API of (waar settable) via capabilities.

### Tesla S batterij — ACTIES (laadsturing, géén Wall Connector nodig)
- **Laadversterkers instellen** («current») → laadstroom A — kern voor zero-export modulatie
- **Stel Laadlimiet SoC in** («limit») → laadlimiet %
- **Start/stop het opladen** («action»)
- **Laadvermogenmeter instellen** («power»)
- **Stel gepland opladen in** («action,hh,mm»)
- **Gepland vertrek instellen** («action,preconditioning_enabled,preconditioning_weekdays_only,off_peak_charging_enabled,off_peak_charging_weekdays_only,hh,mm,op_hh,op_mm»)
- Schakel gepland laden uit · Deactiveer gepland vertrek · Laadpoort open/dicht · Ontgrendel laadpoort

### Tesla S batterij — TRIGGERS (relevant)
Laden begonnen/gestopt · Laadstroom gewijzigd · Max. laadstroom gewijzigd · Laadlimiet SoC gewijzigd · Laad vermogen (AC/DC) · **Modultemperatuur min/max (°C)** (→ <0°C Li-plating-regel) · Oplaadstatus gewijzigd · Online/Offline voor de duur · Batterijniveau (bruikbaar)

### Tesla S batterij — CONDITIES
Oplaadstatus is «state» · Laadpoort is open · Batterijverwarmer is aan

### Tesla S (auto) — ACTIES
Stel online-interval in («interval,unit») · Maak het voertuig wakker («wait») · Sentry Mode («action») · Lees de API-kosten · Bijgewerkte voertuiggegevens (refresh) · Ping de auto

### Tesla S (auto) — TRIGGERS (relevant)
Toestand gewijzigd · Online/Offline voor de duur («duration,unit») · Er is een API-fout opgetreden · API-fout opgetreden voor de duur · Tesla API aanvragen/commando's/wek-commando's/kosten wordt meer/minder dan (+ voor-de-duur) · Accuniveau · Schakelstand gewijzigd · Gebruiker aan-/afwezig

### Tesla S (auto) — CONDITIES
API-fout is/is niet opgetreden · Dagelijkse gemiddelde API-kosten (in %) hoger dan «value» · Toestand is «state» · Schakelstand is «state» · Gebruiker is aanwezig

### Nexus (Zonneplan Batterij) — ACTIES ⚠️ BESTAAN, maar NIET gebruiken (P2)
Thuisgebruik activeren · Powerplay activeren · Thuis optimalisatie activeren («mode») · Home optimization advanced: Charge («charge,discharge»)
> Aansturen = uit vrije handel = verlies onbalans-opbrengst. Alleen lezen.

### Nexus — TRIGGERS (lezen)
Vermogen (W) · Accuniveau (%) · Totaal/dagelijkse import/export (kWh) · Vandaag/Totaal/deze-maand/vorige-maand verdiend (€) · Oplaadstatus veranderd · Batterij online/offline · Dynamische load balancing geactiveerd/gedeactiveerd (+ alle voor-de-duur varianten)

### Nexus — CONDITIES
De oplaadstatus van de batterij is «state»

## Conclusies voor de modules

- **Module 2 (Tesla-control) is native compleet:** Laadversterkers instellen (amps) + Laadlimiet SoC + Start/stop + Gepland vertrek met voorconditionering — allemaal op Tesla S batterij, zonder Wall Connector. Implementatie: onze logica roept deze flow-acties aan (Flow-API) i.p.v. Menno's Wall-Connector-pad.
- **Command-budget (FX1):** triggers + condities op Tesla S (API-fout, API-kosten/aanvragen/commando's-drempels) + actie "Stel online-interval in" (FX2) + "Maak wakker (wait)". v5.3-aannames bevestigd.
- **<0°C-regel:** trigger "Modultemperatuur min/max" of capability `module_temp`.
- **Nexus:** stuur-acties bestaan maar blijven ongebruikt (P2); we lezen vermogen/SoC/verdiensten.

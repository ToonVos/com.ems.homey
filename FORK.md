# FORK — com.ems.homey

Dit is een **fork** van [`com.ems.homey`](https://github.com/b2hvty299s-ux/com.ems.homey) van **Menno de Braak** (MIT). Alle credit voor de basis-app — de adapter-architectuur, capability-map, Open-Meteo solar-forecast, planning-engine, hysterese en dashboard-widgets — is van hem.

Deze fork voegt onderscheidende logica toe voor een specifieke setup (Tesla Model S 100D 2018, Zonneplan Nexus als autonome handelaar, geen Wall Connector, dynamisch EPEX-contract). De huidige focus is **prijs-gestuurd Tesla-laden onder saldering** (export ≈ import → alleen het inkoop-tijdstip telt). Het ontwerp en de rationale leven in de aparte "brein"-repo `ems-homey`.

> **Geïmplementeerde regie:** zie [`docs/EMS-TESLA-PRICE-CHARGING.md`](docs/EMS-TESLA-PRICE-CHARGING.md) voor de volledige beschrijving (scheduler, prijs-horizon, dashboard-override, batterijgezondheid, tuning-laag).

## Verhouding tot upstream

- `origin`   → `ToonVos/com.ems.homey` (deze fork)
- `upstream` → `b2hvty299s-ux/com.ems.homey` (Menno's repo)
- Menno's updates mergen: `git fetch upstream && git merge upstream/main`
- Bijdragen terug: elke module is een schone branch → PR naar upstream zodra/indien Menno openstaat voor samenwerking.

## Wat deze fork toevoegt (zie ems-homey `tasks/phase-3/3.4`)

Elke module = eigen feature-branch, PR-baar naar upstream:

Elke module = eigen feature-branch, PR-baar naar upstream. Status per 2026-06-08:

| Branch | Module | Status |
|---|---|---|
| `feat/m1-autonomous-battery` | Autonome batterij (read-only Nexus) | ✅ |
| `feat/m7-decision-log` | Beslis-log voor terugwerkende analyse | ✅ |
| `feat/m8-tesla-override-widget` | Dashboard-tegel "EMS Tesla-doel" (%/deadline-override) | ✅ |
| `feat/m9-tesla-price-scheduler` | Prijs-gestuurde laadregie (`TeslaScheduler`, modus `price`) | ✅ |
| `feat/m10-direct-tesla-control` | Directe sturing via `runFlowCardAction` (geen flow-koppeling) | ✅ |
| `feat/m11-charge-verify-wake` | Laad-verificatie na 3 min + `car_wake_up` bij mismatch | ✅ |
| `feat/m12-price-charge-mode-settings` | Laadmodus `price` + EV-instellingen herindeling | ✅ |
| `feat/m13-floor-soc-setting` | Instelbare bodem-SoC (panic-vloer) | ✅ |
| `feat/m14-opportunistic-week-charging` | Instelbare klaar-tijd + opportunistisch tot plafond + snelheids-observer | ✅ |
| `feat/m15-battery-health-guard` | Batterijgezondheid: bandgewijze timing hoge SoC | ✅ |
| `feat/m16-tuning-debug-layer` | Week-tuning-laag (correlatie, retentie, week-rapport) | ✅ |
| `feat/m17-energyzero-fullday` | EnergyZero volledige uurprijzen vandaag+morgen | ✅ |

Module 1 (autonome batterij) en de Tesla-sturing zonder Wall Connector zijn **blockers** om de app in deze setup te laten draaien; de prijs-stack (m8–m17) is de onderscheidende regie. Volledige beschrijving: [`docs/EMS-TESLA-PRICE-CHARGING.md`](docs/EMS-TESLA-PRICE-CHARGING.md).

**Nog open (voorraad):** herkomst-tracking (pv_share), accu-veroudering geprijsd + `optimalChargeCap`, datum/weken-vooruit ritplanning + vakantie-hold, post-2027 Nexus-dump-vóór-zonsopgang.

## Afspraken

- Wijzig Menno's beslislogica/dashboard niet — alleen toevoegen via zijn uitbreidings-patroon (config / nieuwe service / nieuwe interface).
- `LICENSE`, `FORK.md` en andere fork-meta blijven op `main` van deze fork; ze gaan **niet** mee in upstream-PR's.
- Attributie: Menno blijft genoemd als oorspronkelijk auteur in `LICENSE`.

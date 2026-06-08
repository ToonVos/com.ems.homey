# FORK — com.ems.homey

Dit is een **fork** van [`com.ems.homey`](https://github.com/b2hvty299s-ux/com.ems.homey) van **Menno de Braak** (MIT). Alle credit voor de basis-app — de adapter-architectuur, capability-map, Open-Meteo solar-forecast, planning-engine, hysterese en dashboard-widgets — is van hem.

Deze fork voegt onderscheidende logica toe voor een specifieke setup (Tesla Model S 100D 2018, Zonneplan Nexus als autonome handelaar, geen Wall Connector, post-saldering). Het ontwerp en de rationale leven in de aparte "brein"-repo `ems-homey`.

## Verhouding tot upstream

- `origin`   → `ToonVos/com.ems.homey` (deze fork)
- `upstream` → `b2hvty299s-ux/com.ems.homey` (Menno's repo)
- Menno's updates mergen: `git fetch upstream && git merge upstream/main`
- Bijdragen terug: elke module is een schone branch → PR naar upstream zodra/indien Menno openstaat voor samenwerking.

## Wat deze fork toevoegt (zie ems-homey `tasks/phase-3/3.4`)

Elke module = eigen feature-branch, PR-baar naar upstream:

| Branch | Module | Type |
|---|---|---|
| `feat/m1-autonomous-battery` | Autonome batterij (read-only Nexus, niet aansturen) | nieuw `interfaces/` + config-vlag |
| `feat/m2-tesla-no-wallconnector` | Tesla-aansturing zonder Wall Connector + command-budget | nieuw `devices/` + hysterese in `EvChargeController` |
| `feat/m3-allin-price` | All-in prijs + adaptieve goedkoop-drempel | uitbreiding `services/DayAheadPrices` |
| `feat/m4-provenance` | Herkomst-tracking (pv_share) | nieuw `services/ProvenanceTracker` |
| `feat/m5-aging-cost` | Accu-veroudering geprijsd + `optimalChargeCap` | nieuw `services/AgingCost` |
| `feat/m6-trip-dates` | Datum/weken-vooruit ritplanning + vakantie-hold | uitbreiding `services/TripPlanner` |
| `feat/m7-decision-log` | Beslis-log voor terugwerkende analyse | nieuw `services/DecisionLog` |

Modules 1 en 2 zijn **blockers** om de app in deze setup te laten draaien (autonome batterij + geen Wall Connector); 3-6 zijn optimalisatie; 7 is de validatie-ruggengraat.

## Afspraken

- Wijzig Menno's beslislogica/dashboard niet — alleen toevoegen via zijn uitbreidings-patroon (config / nieuwe service / nieuwe interface).
- `LICENSE`, `FORK.md` en andere fork-meta blijven op `main` van deze fork; ze gaan **niet** mee in upstream-PR's.
- Attributie: Menno blijft genoemd als oorspronkelijk auteur in `LICENSE`.

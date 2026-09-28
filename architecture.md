# Architecture — Geospatial Agentic AI Stack

> **An end-to-end workflow that takes raw satellite imagery and weather data through agentic data engineering, risk scoring, and into interactive map dashboards — all driven by natural language.**
>
> **Part 1 — Data Engineering:** Developer + [Wherobots MCP](https://api.cloud.wherobots.com/mcp/) → Medallion pipeline (Bronze → Silver → Gold) → Gold Iceberg tables in `org_catalog.gold`
>
> **Part 2 — Map Agent:** [Strands Agent](https://github.com/strands-agents/sdk-python) (Bedrock Claude) + Wherobots MCP + [MapLibre GL JS](https://maplibre.org/) → Interactive maps from natural language
>
> **Target Industries**: Insurance, Commercial Real Estate, Capital Markets, Energy & Utilities

---

## Architecture Overview

The system has two parts — one for data engineering, one for end-user exploration:

```
╔══════════════════════════════════════════════════════════════════════════╗
║  PART 1 — DATA ENGINEERING AGENT                                        ║
║  Persona: Data engineer / analyst in Claude Code or Kiro                ║
║                                                                         ║
║  ┌─────────────────┐     ┌──────────────────────────────────────┐      ║
║  │ Developer        │     │ Wherobots MCP                        │      ║
║  │ (Claude Code /   │────▶│ https://api.cloud.wherobots.com/mcp/ │      ║
║  │  Kiro / VS Code) │     │ + wherobots-pipeline skill           │      ║
║  └─────────────────┘     └───────────────┬──────────────────────┘      ║
║                                          │                              ║
║    "Generate a notebook that scores      │  Discovers catalogs,         ║
║     San Diego buildings for wildfire,    │  generates Sedona SQL,       ║
║     flood, and weather risk"             │  executes on Spark           ║
║                                          ▼                              ║
║  ┌──────────┐   ┌──────────┐   ┌──────────────────────────┐            ║
║  │ RAW (S3) │──▶│ SILVER   │──▶│ GOLD (Apache Iceberg)    │            ║
║  │ NOAA     │   │ Zonal    │   │ org_catalog.gold.*       │            ║
║  │ OPERA    │   │ Stats    │   │ Scoring, weighting,      │            ║
║  │ USFS     │   │ KNN Join │   │ tiers — ~1M x 4 tables   │            ║
║  │ Overture │   │          │   │                          │            ║
║  └──────────┘   └──────────┘   └────────────┬─────────────┘            ║
╚═════════════════════════════════════════════╪═══════════════════════════╝
                                              │
                   The Gold Iceberg tables    │
                   are the handoff point      │
                   between the two parts      │
                                              │
╔═════════════════════════════════════════════╪═══════════════════════════╗
║  PART 2 — END-USER MAP AGENT                │                           ║
║  Persona: Analyst / business user asking questions                     ║
║                                             │                           ║
║  ┌─────────────────┐     ┌──────────────────┴───────────┐              ║
║  │ User prompt:     │     │ Strands Agent                │              ║
║  │ "Show buildings  │────▶│ (Amazon Bedrock Claude)      │              ║
║  │  with high       │     │                              │              ║
║  │  wildfire risk   │     │ Tools: Wherobots MCP (SQL),  │              ║
║  │  near Poway"     │     │   write_layer, publish_map   │              ║
║  └─────────────────┘     │ Skill: open-mapping          │              ║
║                           └──────────┬───────────────────┘              ║
║                                      │ GeoJSON layers + map.json        ║
║                                      ▼  (MapLibre style)                ║
║                           ┌──────────────────────┐                      ║
║                           │ MapLibre viewer       │                      ║
║                           │ http://localhost:8765 │                      ║
║                           │ - OpenFreeMap basemap │                      ║
║                           │ - Updates after every │                      ║
║                           │   answer              │                      ║
║                           └──────────────────────┘                      ║
╚═════════════════════════════════════════════════════════════════════════╝
```

### Why two parts?

| | Part 1: Data Engineering | Part 2: Map Agent |
|---|---|---|
| **Persona** | Data engineer in an IDE | Analyst asking questions |
| **Interface** | Claude Code / Kiro + Wherobots MCP | Strands Agent CLI + MapLibre viewer in the browser |
| **Intelligence** | MCP-guided notebook generation | Skills + map tools (`write_layer`, `publish_map`) |
| **Runs when** | Pipeline build time (once or on schedule) | Ad-hoc, interactive, on demand |
| **Output** | Scored Iceberg tables in `org_catalog.gold` | Interactive MapLibre maps (GeoJSON + style) |
| **MCP servers** | Wherobots | Wherobots |

---

## Notebook Sequence

| Step | Notebook | What it does |
|------|----------|--------------|
| 1 | `bronze-to-silver.ipynb` | Spatial joins, zonal statistics (raster → vector), KNN event proximity → Silver Iceberg |
| 2 | `silver-to-gold.ipynb` | Industry-specific normalization, weighted scoring, risk tiers → Gold Iceberg (optional GeoParquet export) |

> The raw-to-bronze step is handled by Wherobots' catalog — Bronze data lives in `org_catalog` and `wherobots_open_data` as pre-registered Iceberg tables.

---

## Data Sources

| Dataset | Source | Type | Catalog Table |
|---------|--------|------|---------------|
| NOAA SWDI — Hail | [AWS Open Data](https://registry.opendata.aws/noaa-swdi/) | Vector | `org_catalog.noaa_swdi.hail` |
| NOAA SWDI — Storm cell structure | AWS Open Data | Vector | `org_catalog.noaa_swdi.structure` |
| NOAA SWDI — TVS | AWS Open Data | Vector | `org_catalog.noaa_swdi.tvs` |
| OPERA DSWx-S1 | [NASA JPL](https://www.jpl.nasa.gov/go/opera) | Raster (Sentinel-1 SAR, 30 m) | `org_catalog.opera.dswx_s1` |
| USFS Burn Probability | [wildfirerisk.org](https://wildfirerisk.org/) | Raster (COG) | `org_catalog.wildfire_risk.burn_probability_conus` |
| USFS Conditional Flame Length | wildfirerisk.org | Raster (COG) | `org_catalog.wildfire_risk.conditional_flame_length_conus` |
| Overture Buildings | [Wherobots Open Data](https://docs.wherobots.com/) | Vector (GeoParquet) | `wherobots_open_data.overture_maps_foundation.buildings_building` |

---

## Layer Details

### Silver — Spatial Analytics

The heavy compute layer where Wherobots/Sedona performs spatial joins, zonal statistics, KNN, and buffered aggregations to conflate hazard signals onto building footprints.

| Silver Table | Operation | Hazard Source |
|---|---|---|
| `asset_wildfire_exposure` | Zonal statistics (raster → vector) | USFS burn probability + flame length |
| `asset_flood_exposure` | Weekly zonal statistics (per ISO week) | OPERA DSWx-S1 SAR flood |
| `asset_weather_density` | KNN spatial join (k=10, 25km radius) | NOAA SWDI hail / structure / TVS |
| `asset_enriched` | LEFT JOIN of all above onto buildings | All hazards unified |

Each table is an independently materialized Iceberg table — reprocessing one hazard does not require recomputing others.

### Gold — Industry-Specific Scoring

All Gold tables start from `asset_enriched` and apply the same framework:

1. **Normalize** raw hazard metrics to [0, 1] via min-max scaling
2. **Weight** the three factors per industry
3. **Classify** into risk tiers via `percent_rank` over the score distribution (Critical ≥ p95, High ≥ p80, Elevated ≥ p60, Moderate ≥ p30, Low < p30)
4. **Derive** industry-specific metrics

| Gold Table | Industry | Weights (wf / fl / sw) | Key Derived Metrics |
|---|---|---|---|
| `insurance_exposure` | Insurance | 0.40 / 0.40 / 0.20 | exposure_delta, triage_priority, relative_risk_band |
| `cre_risk` | Commercial Real Estate | 0.30 / 0.35 / 0.35 | acquisition_screen_flag, exposure_magnitude_index, hazard_proximity_m |
| `capital_markets_signals` | Capital Markets | 0.20 / 0.30 / 0.50 | disruption_signal, supply_chain_vulnerability, event_density_signal |
| `energy_asset_risk` | Energy & Utilities | 0.40 / 0.20 / 0.40 | outage_probability, wildfire_ignition_risk, weather_impact_frequency |

> For full column-level detail and business logic, see [data_dictionary.md](part1_data_engineering/data_dictionary.md).

---

## Output Destination

Gold tables are Apache Iceberg tables in the participant's Wherobots catalog:

| Destination | Location | Format |
|---|---|---|
| Wherobots catalog | `org_catalog.gold.*` | Apache Iceberg (primary; what Part 2 reads) |
| S3 GeoParquet (optional) | `GEOPARQUET_BASE/<table>` in managed storage | GeoParquet (off by default) |

---

## How the End-User Agent Works (Part 2)

The Strands map agent combines **the Wherobots MCP + two map tools + one skill**:

1. **Wherobots MCP** — the same server as Part 1; the agent explores tables and tests SQL against `org_catalog.gold`
2. **`write_layer`** runs the final query (through the MCP, results capped at 10,000 rows), saves it as GeoJSON, and returns column ranges and categories so the agent can choose colour stops from the real data
3. **`publish_map`** writes a map spec — MapLibre sources and layers, legend, popup fields — and points `maps/current.json` at it
4. The **viewer** (`viewer/index.html`, MapLibre GL JS + OpenFreeMap basemap) polls `current.json` and swaps in each new map; `?map=` permalinks open a fixed map
5. The **`open-mapping` skill** teaches the spec format, data-driven styling expressions (`match`, `interpolate`, zoom ramps) and the tier palette

Answers too large to draw building by building are aggregated in SQL first (for example H3 hexagons with `ST_H3CellIDs`), so the viewer only ever renders what fits in the browser.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Two-layer architecture | Wherobots MCP (data eng) + Strands map agent (maps) | Clean separation: data engineer builds pipeline, analyst explores maps |
| Geographic scope | San Diego, CA | Wildfire + flood + severe weather overlap; compact for workshop |
| Asset type | Buildings (Overture) | Available via Wherobots Open Data; ~1M in San Diego |
| Iceberg as handoff | `org_catalog.gold` | The pipeline writes and the agent reads the same tables; no export or second database |
| Map rendering | MapLibre GL JS on the participant's laptop | Open source, no account or key; maps are standard GeoJSON + MapLibre style files |
| Gold persistence | Iceberg (GeoParquet optional) | One copy for reprocessing, analysis and the map agent |
| Normalization | Min-max (0–1 range) | Intuitive for workshop; AOI-relative (not comparable across regions) |
| Risk tiers | Critical / High / Elevated / Moderate / Low | 5 tiers via `percent_rank` — quantile-based, so AOI-relative |
| Refresh cadence | Full refresh (truncate-and-load) | Suitable for workshop; upsert pattern for production |

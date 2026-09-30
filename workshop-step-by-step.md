# Building a Geospatial Agentic AI Stack on AWS — Workshop Guide

**Turn raw geospatial data into intelligence.** Powered by Wherobots, Amazon Bedrock, and MapLibre.

**Duration:** ~90 minutes
**Level:** Intermediate (comfortable with Python & command line)

---

## What You'll Build

An end-to-end geospatial AI pipeline that scores **357,263 buildings in the City of San Diego** for wildfire, flood, and severe weather risk — then lets you explore them through natural language prompts that generate interactive maps.

**Part 1 — Agentic Data Engineering** (~35 min)
Walk through a Wherobots MCP-powered medallion pipeline (Bronze → Silver → Gold) that turns satellite imagery and weather events into per-building risk scores, stored as Apache Iceberg tables in your Wherobots catalog.

**Part 2 — Map Builder AI Agent** (~40 min)
Run an AI agent that takes prompts like *"Show me buildings with high wildfire risk near Poway"* and draws styled, interactive maps on your laptop — powered by Strands Agents SDK, Amazon Bedrock (Claude), the Wherobots MCP, and MapLibre GL JS.

---

## The Data Story

San Diego sits at the intersection of three natural hazards:

- **Wildfire** — The canyon edges along Mission Trails Regional Park (Tierrasanta, San Carlos, Del Cerro) and Scripps Ranch, where the 2003 Cedar Fire destroyed hundreds of homes, are the city's wildland-urban interface. **97,412 buildings** (27%) carry some wildfire exposure; wildfire is what lifts a building from high to critical.
- **Severe weather** — Radar-detected storm cells and hail within 25 km touch **99% of all buildings** at some level, and storm density is what separates the tiers inside the city.
- **Flood** — Rare. In the December-to-March window no city footprint saw satellite-observed water, so the flood factor is zero for every building; at county scale 114 buildings did.

The same building gets **different risk scores** depending on who's asking:
- An **insurer** weights wildfire and flood equally (0.40/0.40) — they care about claims
- A **real estate investor** weights severe weather highest (0.35) — they care about long-term value
- An **energy company** weights wildfire at 0.40 — they care about grid infrastructure near vegetation

This is what you'll explore: ~1M buildings, 4 industry perspectives, one map.

---

## Prerequisites

### Accounts & API Keys

| What | Where to get it | Used in |
|---|---|---|
| **Wherobots account** | [cloud.wherobots.com](https://cloud.wherobots.com) — org must be **Professional or Enterprise tier** (MCP access is not available on Community orgs) | Part 1 + 2 |
| **Wherobots API key** | Wherobots Console → API Keys — generate it in the Professional/Enterprise-tier org | Part 1 + 2 |
| **AWS account** | Provided for this event through AWS Workshop Studio (or your own account with Bedrock access) | Part 2 |
| **AWS Bedrock model access** | Claude Opus 4.8 in `us-west-2` (Bedrock console → Model access) | Part 2 |

> **Note:** There is no AWS stack to deploy. Part 1 runs on Wherobots Cloud, and Part 2 runs on your laptop; the only AWS service it calls is Bedrock.
>
> **Wherobots tier check:** the Wherobots MCP server is gated by org tier. If your API key belongs to a Community-tier org, every MCP call fails with `MCP access is not enabled for your organization` — you'll need a key from a Professional or Enterprise org (workshop instructors can provide one). Verify your tier in the Wherobots Console under **Settings → Organization** before the session.

### Software

| What | Version | Check with |
|---|---|---|
| Python | 3.10+ | `python3 --version` |
| pip | latest | `pip --version` |
| git | any | `git --version` |
| AWS CLI | v2 | `aws --version` |
| A web browser | any recent | Part 2's map opens at `http://localhost:8765` |
| Kiro IDE | latest | [kiro.dev](https://kiro.dev) (optional, recommended) |
| Wherobots Extension | latest | Install via `kiro --install-extension wherobots.wherobotsjobsubmit` |

---

## Setup (~15 min)

### Step 1 — Clone & install

> **Python 3.10+ needed.** macOS's `python3` is 3.9.6 (too old) — `brew install python@3.13`, then use `python3.13 -m venv .venv` below.

```bash
git clone https://github.com/prantogg/aws-wherobots-cng-workshop.git
cd aws-wherobots-cng-workshop
python3 -m venv .venv
source .venv/bin/activate
pip install -r part2_map_agent/requirements.txt
```

Verify the install:

```bash
python -c "import strands, mcp, geopandas; print('venv ready')"
```

### Step 2 — Check Bedrock access (~2 min)

Part 2's agent uses Claude on Amazon Bedrock with your AWS credentials. Confirm your credentials work and the model answers in `us-west-2`:

```bash
aws sts get-caller-identity
aws bedrock-runtime converse \
  --model-id us.anthropic.claude-opus-4-8 \
  --messages '[{"role":"user","content":[{"text":"Reply with the word ready"}]}]' \
  --region us-west-2 \
  --query 'output.message.content[0].text'
```

The second command should print `"ready"`. An `AccessDeniedException` means model access for **Claude Opus 4.8** isn't enabled in `us-west-2` (Bedrock console → *Model access*), or your role lacks Bedrock permissions; see Troubleshooting.

### Step 3 — Configure credentials

```bash
cp .env.example .env
```

Edit `.env` with your Wherobots API key (the AWS section can stay commented out if Step 2 worked with your default credentials):

```bash
# Wherobots Cloud
WHEROBOTS_API_KEY=your-wherobots-api-key
# Runtime for the Part 2 map agent's SQL queries; unset uses your organization's
# default runtime.
WHEROBOTS_RUNTIME_ID=micro

# AWS (for Bedrock)
AWS_DEFAULT_REGION=us-west-2
BEDROCK_MODEL_ID=us.anthropic.claude-opus-4-8
```

### Step 4 — Set up Kiro with Wherobots extension (recommended)

If you're using Kiro, install the Wherobots extension for integrated catalog browsing, AI-assisted notebook authoring, and remote compute:

1. Install: `kiro --install-extension wherobots.wherobotsjobsubmit`
2. Command Palette (Cmd+Shift+P) → **Wherobots: Set API Key** → paste your Wherobots key
3. The extension auto-configures the MCP server and Data Hub sidebar

> **Always open Kiro with `scripts/kiro.sh`** from the repo root. Kiro fills in the `${WHEROBOTS_API_KEY}` placeholder in `.kiro/settings/mcp.json` from the environment it was started with, not from `.env`. Opening Kiro from the Dock leaves the placeholder unresolved and Wherobots MCP calls fail. `scripts/kiro.sh --check` shows whether `.env` provides it. If the MCP servers panel shows nothing at all, check that **Kiro Agent: Configure MCP** is Enabled in Settings.

To connect notebooks to Wherobots compute (needed for Part 1):
1. Wherobots sidebar → **Create Workspace** → set region and instance size (**Medium** for `bronze-to-silver`, about 13 minutes for the City of San Diego; **Small** for `silver-to-gold`, about 3 minutes; the county run needs **Large** and about 35 minutes) → **Start**
2. Open a `.ipynb` file → select the Wherobots remote runtime as your kernel
3. Code now executes on Wherobots Cloud (Sedona)

### Step 5 — Configure MCP servers

Kiro users are done: the repo ships `.kiro/settings/mcp.json` with the Wherobots server and its read-only tools pre-approved. For VS Code or Claude Desktop, add the same server to your IDE's MCP settings:

```json
{
  "mcpServers": {
    "wherobots": {
      "url": "https://api.cloud.wherobots.com/mcp/",
      "headers": {
        "X-API-Key": "${WHEROBOTS_API_KEY}"
      }
    }
  }
}
```

The Part 2 agent connects to the Wherobots MCP itself, using `WHEROBOTS_API_KEY` from `.env`; no IDE configuration is needed for it.

## Part 1: Agentic Data Engineering with Wherobots MCP (~35 min)

### Overview

In this part, you'll walk through how the **Wherobots MCP server** was used to build a medallion data pipeline that transforms raw satellite and weather data into per-building risk scores. The scores land as Iceberg tables in your Wherobots catalog — you'll explore how they got there and what they mean.

### Architecture

```
Bronze (Raw Sources)          Silver (Enriched)              Gold (Industry-Scored)
──────────────────────        ────────────────────           ────────────────────────
Overture Buildings ──┐
                     ├──▶ asset_wildfire_exposure ──┐
USFS Burn Probability┤                              │
USFS Flame Length ───┘                              │
                                                    ├──▶ asset_enriched ──▶ insurance_exposure
OPERA DSWx-S1 ──────▶ asset_flood_exposure ─────────┤                  ──▶ cre_risk
                                                    │                  ──▶ capital_markets_signals
NOAA SWDI Hail ──┐                                  │                  ──▶ energy_asset_risk
NOAA SWDI Struct ┼──▶ asset_weather_density ────────┘
NOAA SWDI TVS ───┘
                                    │
                                    ▼
                    org_catalog.gold (Apache Iceberg)
                     read by the Part 2 map agent
```

### Step 1 — Explore the data catalog with Wherobots MCP (10 min)

The Wherobots MCP connects to a massive catalog of geospatial data. Let's explore what's available.

**Try these prompts in your MCP chat:**

> *"What tables are available in org_catalog.noaa_swdi?"*

This shows the severe weather datasets: hail events, radar-identified storm cells, and tornado vortex signatures.

> *"Describe the schema of wherobots_open_data.overture_maps_foundation.buildings_building"*

This is the Overture Maps building footprint dataset — every building polygon in the world.

> *"Show me 5 sample rows from org_catalog.noaa_swdi.hail where the geometry is within San Diego County"*

This shows actual hail events with location, severity, and timestamp.

**What you're seeing:** The first two prompts use the catalog and schema tools, which read metadata and return instantly even for tables with billions of rows. The third prompt runs SQL: the first SQL query of a session starts a SQL runtime, which takes about 90 seconds; later queries return in seconds.

**Available datasets:**

| Source | Catalog Table | Type | Description |
|---|---|---|---|
| Overture Buildings | `wherobots_open_data.overture_maps_foundation.buildings_building` | Vector | 2.5 billion footprints worldwide; ~357K in the City of San Diego, ~1.03M in the county |
| USFS Burn Probability | `org_catalog.wildfire_risk.burn_probability_conus` | Raster | Annual burn probability grid, CONUS, 30 m (24 GB) |
| USFS Flame Length | `org_catalog.wildfire_risk.conditional_flame_length_conus` | Raster | Expected flame length if fire occurs, CONUS, 30 m (22 GB) |
| OPERA DSWx-S1 | `org_catalog.opera.dswx_s1` | Raster | Sentinel-1 SAR surface water / flood (30 m), Southern California, Dec 2025 – Mar 2026 |
| NOAA SWDI — Hail | `org_catalog.noaa_swdi.hail` | Vector | 26M hail detections, 2024–2025, with severity |
| NOAA SWDI — Storm cell structure | `org_catalog.noaa_swdi.structure` | Vector | 83M radar-identified storm cells of any intensity (max reflectivity, VIL, cell heights), 2024–2025 |
| NOAA SWDI — TVS | `org_catalog.noaa_swdi.tvs` | Vector | 93K tornado vortex signatures, 2024–2025 |
| NOAA SWDI — Warnings | `org_catalog.noaa_swdi.warn` | Vector | Warning polygons 2001–2016 (archive; not used by the pipeline) |

### Step 2 — Walkthrough: Bronze → Silver pipeline (10 min)

Open the notebook at `part1_data_engineering/bronze-to-silver.ipynb`. This was **generated by the Wherobots MCP** using the pipeline skill (`part1_data_engineering/skills/wherobots-pipeline/SKILL.md`).

The Silver layer enriches each building with hazard data through three spatial operations:

**Wildfire exposure** — Zonal statistics (`RS_ZonalStats`):
| Input | Operation | Output |
|-------|-----------|--------|
| Overture Buildings + USFS Burn Probability raster | Extract mean/max burn probability for each building footprint | `asset_wildfire_exposure` — wildfire_factor per building |

> **Key insight:** A building on a canyon edge in Tierrasanta or Scripps Ranch might sit directly on high burn probability land, while its neighbor 200m away is shielded by a ridge. This is why nearby buildings get different scores.

**Flood exposure** — Weekly zonal statistics (per ISO week):
| Input | Operation | Output |
|-------|-----------|--------|
| Overture Buildings + OPERA DSWx-S1 SAR flood raster (weekly) | For each ISO week in the flood window, zonal-stat max water-classification per building → append to Iceberg | `asset_flood_exposure` — one row per (asset, week); silver-to-gold aggregates to max class, event count, duration |

**Severe weather density** — KNN spatial join (`ST_KNN`):
| Input | Operation | Output |
|-------|-----------|--------|
| Overture Buildings + NOAA SWDI (hail, storm cells, TVS) | Find 10 nearest weather events within 25km | `asset_weather_density` — event counts at 5km and 25km thresholds |

> **Try it yourself:** Ask the Wherobots MCP: *"How many hail events occurred within 25km of downtown San Diego (32.72, -117.16) in the past year?"*

### Step 3 — Walkthrough: Silver → Gold scoring (5 min)

Open the notebook at `part1_data_engineering/silver-to-gold.ipynb`. This applies a **4-step scoring framework**:

**1. Normalize** — Min-max scale each hazard metric to [0, 1]
**2. Weight** — Apply industry-specific weights:

| Industry | Wildfire | Flood | Severe Weather | Why this weighting? |
|---|---|---|---|---|
| Insurance | 0.40 | 0.40 | 0.20 | Claims are driven by fire and flood |
| Commercial Real Estate | 0.30 | 0.35 | 0.35 | Long-term value affected by all hazards |
| Capital Markets | 0.20 | 0.30 | 0.50 | Operational disruption from weather events |
| Energy & Utilities | 0.40 | 0.20 | 0.40 | Grid infrastructure near vegetation and storm paths |

**3. Classify** — Assign risk tiers by percentile rank of the score within the area, so every industry gets a comparable distribution regardless of how its raw scores are spread:

| Tier | Percentile of `risk_score` |
|---|---|
| Critical | top 5% |
| High | 80th – 95th |
| Elevated | 50th – 80th |
| Moderate | 20th – 50th |
| Low | bottom 20% |

Tied scores are common (most buildings have zero flood and near-zero wildfire), so the realised shares deviate from these cuts at the bottom: in the City of San Diego run, insurance lands at 5.0% critical as designed but only 2.2% high and 39.7% elevated, because most buildings in the middle of the distribution tie.

**4. Derive** — Compute industry-specific metrics (e.g., `triage_priority`, `outage_probability`)

**The weighting matters:** each industry also reads a different aspect of each hazard (insurance uses mean burn probability and flood duration; energy uses flame length and events within 5 km), so the rankings diverge. In the City of San Diego run the insurer flags 17,864 critical buildings and the utility 5,441, but only **725** are critical for both; **14,807** of the insurer's critical buildings are low or moderate for the utility, and only 13% of buildings (47,216 of 357,263) land in the same tier under both lenses. Same data, different lens.

> 📖 See `part1_data_engineering/data_dictionary.md` for the full schema and business logic of every table.

### Step 4 — Verify the Gold tables (10 min)

silver-to-gold wrote the four Gold tables as Iceberg tables in your Wherobots catalog, under `org_catalog.gold`. Part 2's agent reads them from there. Let's verify and explore them.

**Check row counts** — ask the Wherobots MCP in your IDE chat:

> *"How many rows are in each of org_catalog.gold.insurance_exposure, cre_risk, capital_markets_signals and energy_asset_risk?"*

**Expected:** 357,263 rows in each table, one per building in the City of San Diego (the reference area).

**Explore the risk distribution:**

> *"For org_catalog.gold.insurance_exposure, show the risk tier distribution: count of buildings and average risk_score per tier"*

You should see:

| Tier | Buildings | Avg Score | Dominant Driver |
|------|----------|-----------|-----------------|
| critical | 17,864 | 0.203 | Storm density (0.87) plus the wildfire edge (avg factor 0.07, ten times any other tier) |
| high | 8,013 | 0.172 | Storm density (0.85) |
| elevated | 141,719 | 0.170 | Storm density (0.84) |
| moderate | 103,052 | 0.136 | Storm density (0.67) |
| low | 86,615 | 0.102 | Lower storm density (0.50); wildfire and flood zero |

**What to notice:**
- **Storm density drives the tiers inside the city.** The severe-weather factor climbs from 0.50 in the low tier to 0.87 in critical, and 355,244 of 357,263 buildings have some storm exposure. Wildfire is small in absolute terms but is what separates critical from high (0.072 against 0.007). Flood is zero for every building: no city footprint saw satellite-observed water between December and March
- **Risk is localized along the canyon edges.** Within 3 km of Tierrasanta and of San Carlos and Del Cerro, along Mission Trails Regional Park, about 48% of buildings are high or critical; Scripps Ranch, where the 2003 Cedar Fire burned, 25%; downtown 2.3%; Rancho Bernardo none
- **7% of the city is high or critical** (25,877 buildings), not the 20% the percentile cuts promise, because tied scores collapse the high tier; the story is *where* they are, not how many
- Different industry tables weight the **same hazards differently** and read different metrics — only 13% of buildings share a tier between insurance and energy
- Tiers are **relative to the AOI you ran**. At county scale the eastern wildland-urban interface (Ramona, Julian) takes the top tier and the city's canyon edges move down the ranking. Same data, different frame

> **Try it:** *"What are the top 10 buildings by risk_score in org_catalog.gold.insurance_exposure? Show asset_id, risk_score, wildfire_factor, flood_factor, and severe_weather_factor"*

### Key Takeaways — Part 1

- **Wherobots MCP** gives you an AI-accessible interface to spatial data catalogs and processing — you didn't write Sedona code by hand
- The **medallion architecture** (Bronze → Silver → Gold) separates raw ingestion from enrichment from business scoring
- **Spatial operations** (zonal stats, KNN joins) run server-side on Apache Sedona — even billions of rows
- **Gold stays in Iceberg** in your Wherobots catalog — the same tables feed later pipelines and the Part 2 agent, with no export step
- The same data pipeline supports **4 different industry verticals** with different scoring weights from identical source data
- The risk story is **localized**: it concentrates on the canyon edges and is nearly absent downtown, and wildfire is the factor that separates critical from high

---

## Part 2: Map Builder AI Agent (~40 min)

### Overview

Now let's make the data visual. You'll run an AI agent that turns natural language prompts into interactive maps. The agent:

1. Uses **Amazon Bedrock (Claude)** to interpret your prompt and plan the analysis
2. Queries the Gold tables in your Wherobots catalog through the **Wherobots MCP**
3. Saves the answer as a map layer and a small map description (a MapLibre style)
4. Shows it in a **MapLibre** map on your laptop that updates after every answer

Everything the map needs is open: MapLibre GL JS for rendering, an OpenFreeMap basemap, and GeoJSON files on your disk. No map account, no API key.

### Architecture

```
User: "Show me buildings with high wildfire risk near Poway"
                    │
                    ▼
        ┌───────────────────────────┐
        │  Strands Agent            │
        │  (Bedrock Claude)         │
        │                           │
        │  Tools: Wherobots MCP     │
        │         write_layer       │
        │         publish_map       │
        └─────────────┬─────────────┘
                      │ SQL via MCP
                      ▼
        ┌───────────────────────────┐
        │  Wherobots Cloud          │
        │  org_catalog.gold.*       │
        │  (Iceberg, ~1M × 4)       │
        └─────────────┬─────────────┘
                      │ query result
                      ▼
        viewer/maps/<map>/  (GeoJSON + map.json)
                      │
                      ▼
        MapLibre viewer — http://localhost:8765 🗺️
```

### Prerequisites for Part 2

Part 2 runs the Strands agent locally in **the Python virtualenv you created in
Setup Step 1**. Before continuing, make sure you have it activated:

```bash
# From the repo root
source .venv/bin/activate
python -c "import strands, mcp, geopandas; print('venv OK')"
```

If `.venv/` doesn't exist or the import errors, re-run Setup Step 1:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r part2_map_agent/requirements.txt
```

`./run.sh` auto-sources `.venv/bin/activate` for each invocation, but the venv
itself must already exist. Without it you'll see `ModuleNotFoundError: No
module named 'strands'` (or similar) when the agent starts.

Part 2 reads the Gold tables your Part 1 run produced (`org_catalog.gold.*`), so silver-to-gold must have finished first.

### Step 1 — Navigate to the agent and understand the tools (5 min)

```bash
cd part2_map_agent
```

The agent has two kinds of tools:

| Tool | Purpose |
|----------|---------|
| Wherobots MCP (`describe_table_tool`, `submit_query_tool`, …) | Explore tables and test queries when the agent needs to |
| `write_layer` | Run the final query and save the result as a map layer, returning value ranges and categories so the agent can pick sensible colours |
| `publish_map` | Save the map description (layers, colours, legend, popups) and update the viewer |

The agent learns the map format from one skill, **`skills/open-mapping/SKILL.md`**: how to colour by a number or a category, the risk-tier palette, and how to handle answers too big to draw building by building.

The map itself is `viewer/index.html`: MapLibre GL JS on an OpenFreeMap basemap, about 150 lines.

### Step 2 — Run the agent: from a simple map to a stunning one (15 min)

Start the agent in **interactive mode**:

```bash
./run.sh
```

Then open **http://localhost:8765** in your browser and keep that tab open. It shows *No map yet* until the first answer, then switches to each new map by itself.

> **The first answer takes a minute or two** while Wherobots starts compute for your queries (the agent starts it as soon as it launches). Later answers come back in seconds to about a minute.

Try this first prompt — it builds a **triage map** of the buildings an underwriter should look at first:

> **Suggested prompt:** *"As an insurance underwriter, map the high and critical risk buildings across San Diego County on a dark basemap, colored by risk tier — red for high, dark red for critical."*

**What happens behind the scenes:**
1. The agent writes a query for the high and critical insurance buildings
2. `write_layer` runs it and reports the result's size and value ranges
3. The agent designs the map: colours for each tier, a legend, popups
4. `publish_map` saves it, and your browser tab updates

**What you'll see:** there are **205,454** high and critical buildings in the county (154,090 high, 51,364 critical). That's more than the agent draws one by one (it works within 10,000 features per layer), so it will usually group them into small hexagons coloured by their dominant tier, and tell you it did. The pattern is the point: the risk rakes across the **eastern backcountry** (Poway, Ramona, Julian), the wildland-urban interface, *not* the coast. Wildfire is the escalator that pushes a building into the critical tier.

> **Tip:** Ask a follow-up: *"add a popup showing the building count and average risk score for each hexagon."* Follow-ups on the same map keep your current zoom and position.

<!-- screenshot: step2-1 hexagons coloured by dominant tier (dark basemap) -->

#### Now make it cool — a heatmap that resolves into the buildings

Stay in the same agent session and add more layers. A single follow-up turns the map into a **zoom-aware** view: a risk-density heatmap when you're zoomed out, individual buildings when you zoom in.

> **Suggested prompt:** *"Now add a risk-density layer: aggregate these buildings into an H3 hexbin heatmap colored by their average risk score, with fine bins. Make the heatmap fade out as I zoom in while the buildings fade in — so I see county-wide hotspots when zoomed out and the actual buildings when zoomed in."*

**What the agent does:**
1. `write_layer` → fine H3 hexagons with the average `risk_score` of the buildings inside each
2. `write_layer` → a building layer for the zoomed-in view (within the 10,000-feature limit, so the agent picks the most relevant buildings, such as the critical tier, and says so)
3. `publish_map` → MapLibre zoom expressions on the layers' opacity: the hexagons fade out and the buildings fade in as you zoom

**What you'll see:** zoomed out, the county glows with **average-risk hotspots**. Zoom in past about z12 and the hexagons dissolve into the actual buildings, tier-coloured and clickable. Same data, two reading altitudes, entirely driven by style.

> **Why it works:** the zoom behaviour is a MapLibre style expression (`["interpolate", ["linear"], ["zoom"], …]` on `fill-opacity`), not special viewer code. Open `viewer/maps/<map>/map.json` to see exactly what the agent wrote.

<!-- screenshot: step2-2 zoomed-out hexbin heatmap; step2-3 zoomed-in cross-fade -->

### Step 3 — Explore with more prompts (15 min)

Continue in **interactive mode** — the agent remembers context from previous maps. Try these prompts to explore different perspectives:

---

**Spatial query:**

> *"What are the 100 highest-risk buildings within 10 miles of downtown San Diego (32.7157, -117.1611)? Show them on a map, and draw the 10-mile radius as a visible buffer circle for context."*

The agent runs a distance query on Wherobots and adds a second layer with the 10-mile circle (transparent fill, visible outline). Notice where the top 100 sit inside the circle, and ask the agent what drives their scores; the answer is different from the backcountry.

<!-- screenshot: step3-1 top 100 within 10 miles, with buffer circle -->

---

**The wildfire story:**

> *"Map all buildings near Poway with wildfire_factor above 0.3. Use a heat gradient to show severity."*

These are buildings at the wildland-urban interface. The gradient shows which specific buildings face the highest burn probability — the 2003 Cedar Fire and 2007 Witch Creek Fire swept through this area.

<!-- screenshot: step3-2 Poway wildfire gradient -->

### Step 4 — Explore the map (5 min)

In the map tab you can:
- **Click** buildings or hexagons to see their scores and factor breakdowns
- **Zoom and pan** — follow-ups on the same map keep your view; a new map jumps to its own area
- **Ask for changes in words** — *"make it a light basemap"*, *"only show wildfire above 0.5"*, *"add the energy view as a second layer"*
- **Share a snapshot** — each answer ends with a permalink (`http://localhost:8765/?map=maps/<map>/map.json`) that always opens that map

### Step 5 — Bonus: look under the hood (5 min)

Every map is two kinds of plain files in `part2_map_agent/viewer/maps/<map>/`:
- `<layer>.geojson` — the query result, readable by QGIS, geopandas, or any GIS
- `map.json` — sources, layers, legend and popups in the MapLibre style format

Open a `map.json`, change a colour in a `fill-color` expression, save, and reload the permalink. That's the whole rendering contract: the agent doesn't draw anything itself, it writes a standard style.

### Key Takeaways — Part 2

- The agent **reuses the Wherobots MCP** from Part 1: the same tables and the same SQL engine serve both the pipeline and the map agent
- **Skills** (`.md` files) teach the agent the map format and styling conventions at runtime
- The agent handles multi-step workflows: query → summarize the result → design the style → publish
- **Open formats end to end** — Iceberg for the Gold tables, GeoJSON for answers, the MapLibre style spec for maps
- Natural language makes spatial analysis accessible to non-technical users

---

## Putting It Together

Part 1 and Part 2 form a complete geospatial AI stack:

| Layer | Technology | Role |
|---|---|---|
| **Data Sources** | NOAA, USFS, OPERA (NASA), Overture Maps | Raw geospatial data |
| **Spatial Processing** | Wherobots Cloud (Apache Sedona) | Spatial joins, zonal stats, risk scoring |
| **Data Store** | Wherobots catalog (Apache Iceberg) | Gold tables for pipelines and the agent |
| **AI Orchestration** | AWS Strands Agents SDK + Amazon Bedrock | Natural language → queries → maps |
| **Visualization** | MapLibre GL JS + OpenFreeMap | Interactive maps from open styles and data |

**Two modes of interaction:**
- **Developer** — Wherobots MCP in your IDE to explore data and build pipelines (Part 1)
- **Business user** — the map agent: plain-language questions, maps as answers (Part 2)

**Two phases of the pipeline:**
- **Part 1** is the **data pipeline** — reproducible, automated, runs on a schedule
- **Part 2** is the **AI agent** — flexible, conversational, good for exploration and ad-hoc analysis

In production, you'd use both: pipelines to keep data fresh, agents to let anyone explore it.

---

## Next Steps

- **Productionize** — Amazon Bedrock AgentCore provides runtime, identity, memory, and monitoring for deploying agents
- **More hazards** — Add earthquake, drought, or climate projection data to the scoring model
- **Custom weights** — Modify `risk_weights.yaml` to tune scoring for your specific use case
- **AWS Marketplace** — Wherobots is available on AWS Marketplace for enterprise deployment

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `AccessDeniedException` from Bedrock | Check IAM permissions + Claude model access in Bedrock console. The role needs `bedrock:Converse` / `bedrock:ConverseStream` (the Strands SDK uses the Converse API) in addition to `bedrock:InvokeModel*` — on AWS Workshop Studio accounts, make sure `WSParticipantRole` includes them. |
| `AWS credentials for Bedrock are not working` at agent start | Your AWS session expired or isn't set. Refresh it (e.g. `aws sso login --profile <profile>`, or re-export the Workshop Studio credentials) and re-run `./run.sh`. |
| Wherobots MCP not connecting | Verify API key and `https://api.cloud.wherobots.com/mcp/` URL |
| `MCP access is not enabled for your organization` | Your Wherobots API key belongs to a Community-tier org. Use a key from a **Professional or Enterprise** org (see Prerequisites). |
| First answer takes minutes | Wherobots is starting compute for your queries. It stays warm while you keep asking; after about 5 idle minutes the next question starts it again. |
| Map tab stays on *No map yet* | The agent hasn't published a map yet (watch the terminal), or the tab is an old copy: reload `http://localhost:8765` with Cmd+Shift+R. |
| `Port 8765 is busy` | Another agent or server is using it. Quit it, or set `MAP_VIEWER_PORT=8766` in `.env` and open that port instead. |
| Agent says the answer was capped at 10,000 | That's the per-layer limit. Narrow the question (an area, a tier) or ask for hexagons instead of buildings. |
| Agent can't find a table or column | Part 1's silver-to-gold hasn't finished, or wrote to a different database. Check with the Wherobots MCP that `org_catalog.gold` has the four tables. |
| Agent generates wrong SQL | Schema is in the system prompt — check `agent.py` for table definitions |
| `ModuleNotFoundError` | Activate virtualenv: `source .venv/bin/activate` |

## Useful Links

- [Strands Agents SDK](https://github.com/strands-agents/sdk-python)
- [Amazon Bedrock Docs](https://docs.aws.amazon.com/bedrock/)
- [Wherobots Cloud](https://www.wherobots.com/)
- [Wherobots MCP Docs](https://docs.wherobots.com/develop/mcp/mcp-server-setup.md)
- [Apache Sedona SQL Functions](https://sedona.apache.org/latest-snapshot/api/sql/Overview/)
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)
- [MapLibre Style Spec](https://maplibre.org/maplibre-style-spec/) — the format of each map's `map.json`
- [OpenFreeMap](https://openfreemap.org/) — the free basemap the viewer uses

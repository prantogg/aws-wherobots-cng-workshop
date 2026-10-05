# From Satellite to Signal
### Building a Geospatial Agentic AI Stack on AWS

**Presented by Wherobots and AWS at the CNG Forum**
90-minute hands-on workshop

> An end-to-end workflow that takes raw satellite imagery and weather data through agentic data engineering, risk scoring, and into interactive map dashboards — all driven by natural language.

---

## The Data Story

**357,263 buildings in the City of San Diego** scored for wildfire, flood, and severe weather risk across 4 industry verticals (insurance, commercial real estate, capital markets, energy). The canyon edges along Mission Trails Regional Park and Scripps Ranch — where the 2003 Cedar Fire destroyed hundreds of homes — are where risk concentrates: within 3 km of Tierrasanta about half the buildings score high or critical for insurance, while downtown almost none do. Same buildings, different scores depending on who's asking.

---

## What You'll Build

**Part 1 — Agentic Data Engineering** (Wherobots MCP)
- Explore satellite and weather data catalogs via the Wherobots MCP server
- Walk through a medallion pipeline (Bronze → Silver → Gold) that scores buildings using zonal statistics, KNN spatial joins, and temporal aggregation
- Verify 4 Gold tables in your Wherobots catalog with industry-specific risk tiers

**Part 2 — Map Builder AI Agent** (Strands + Bedrock + Wherobots MCP + MapLibre)
- Open a MapLibre map of every building you scored, coloured by risk for four industries
- Ask a Strands agent about it: *"Which neighbourhoods have the most critical buildings for insurance?"*, *"Top 10 buildings by wildfire near Tierrasanta"*
- The agent drives the map and answers from your own Gold tables through the Wherobots MCP

## Architecture

```
Part 1: Data Engineering Agent          Part 2: Map + Strands Agent
─────────────────────────────           ──────────────────────────
Developer in Claude Code / Kiro         Browser: MapLibre map + chat
        │                                       │ ▲ map tools run here
        ▼                                       ▼ │
┌─────────────────────┐               ┌───────────────────────┐
│ Wherobots MCP       │               │ Strands Agent         │
│ Spatial SQL on      │   ┌───────────┤ (Bedrock Claude)      │
│ Apache Sedona       │   │  queries  │ + Wherobots MCP       │
└────────┬────────────┘   │  via MCP  └───────────────────────┘
         │                │
         ▼                ▼
 Bronze → Silver → Gold ─────────┐      Map tiles of every building,
                                 │      pre-built, from a public
          org_catalog.gold       │      bucket ──► browser
          Iceberg, 357K × 4 ◀────┘
```

> See [architecture.md](architecture.md) for the full architecture with data sources, layer details, and design decisions.

---

## Get Started

👉 **Go straight to the [step-by-step workshop guide](workshop-step-by-step.md).**

It walks you through everything in order — setup (clone, credentials, MCP configuration), then the full 90-minute hands-on workshop from Part 1 (data engineering) through Part 2 (the map agent).

---

## Repository Structure

```
├── README.md                          # This file
├── CLAUDE.md                          # Project guide for AI coding agents
├── architecture.md                    # Two-part architecture diagram + design decisions
├── workshop-step-by-step.md           # 90-minute workshop guide
├── .env.example                       # Credential template
│
├── part1_data_engineering/
│   ├── bronze-to-silver.ipynb         # Spatial joins, zonal stats, KNN (generated via MCP)
│   ├── silver-to-gold.ipynb           # Industry scoring, risk tiers (generated via MCP)
│   ├── data_dictionary.md             # Full schema + business logic (silver + gold tables)
│   ├── custom-pipelines/              # Participant-generated pipeline variations
│   └── skills/wherobots-pipeline/     # Skill that guides MCP toward deterministic output
│
├── part2_map_app/
│   ├── serve.py                       # Local server: Strands agent, building queries, static files (localhost:8765)
│   ├── index.html                     # MapLibre map, chat, and the map tools the agent calls
│   ├── copilot.json                   # Agent system prompt + map tool definitions
│   ├── api/                           # The same endpoints for a Vercel deploy (take-home)
│   └── data/                          # Wherobots export + publish steps for the map tiles
│
├── part2_map_agent/
│   ├── requirements.txt               # Python dependencies (Part 2 installs these)
│   └── agent.py, viewer/, skills/     # Earlier terminal map agent, not used in the workshop
│
├── scripts/
│   ├── bootstrap.py                   # Wherobots org_catalog ingest (Bronze)
│   ├── run_bootstrap.py               # Local wrapper that submits bootstrap.py
│   └── kiro.sh                        # Opens Kiro with .env exported
```

---

## Stack

| Component | Technology | Role |
|-----------|-----------|------|
| **Data Processing** | Wherobots Cloud (Apache Sedona) + Wherobots MCP | Spatial SQL, medallion pipeline, agent queries |
| **Data Store** | Wherobots catalog (Apache Iceberg) | Gold tables for pipelines and the agent |
| **AI Orchestration** | Amazon Bedrock (Claude Opus 4.8) + Strands Agents SDK | Agent that drives the map and answers questions with queries |
| **Visualization** | MapLibre GL JS + OpenFreeMap + PMTiles | An interactive map of every building |

---

## Links

- [Workshop Guide](workshop-step-by-step.md) — Full 90-minute step-by-step
- [Architecture](architecture.md) — Two-part diagram, data sources, design decisions
- [Strands Agents SDK](https://github.com/strands-agents/sdk-python) — Agent framework
- [Wherobots Cloud](https://www.wherobots.com/) — Managed Apache Sedona
- [Wherobots MCP](https://docs.wherobots.com/develop/mcp/mcp-server-setup.md) — MCP server docs
- [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/) — Foundation model hosting
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) — Map rendering
- [MapLibre Style Spec](https://maplibre.org/maplibre-style-spec/) — Format of each map's `map.json`

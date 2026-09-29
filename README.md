# From Satellite to Signal
### Building a Geospatial Agentic AI Stack on AWS

**Presented by Wherobots and AWS at the CNG Forum**
90-minute hands-on workshop

> An end-to-end workflow that takes raw satellite imagery and weather data through agentic data engineering, risk scoring, and into interactive map dashboards — all driven by natural language.

---

## The Data Story

**1,027,269 San Diego County buildings** scored for wildfire, flood, and severe weather risk across 4 industry verticals (insurance, commercial real estate, capital markets, energy). The wildland-urban interface near Ramona, Julian and Poway — where the 2003 Cedar Fire and 2007 Witch Creek Fire devastated neighborhoods — is where risk concentrates: within 3 km of Ramona every building scores high or critical for insurance, while downtown San Diego has none. Same buildings, different scores depending on who's asking.

---

## What You'll Build

**Part 1 — Agentic Data Engineering** (Wherobots MCP)
- Explore satellite and weather data catalogs via the Wherobots MCP server
- Walk through a medallion pipeline (Bronze → Silver → Gold) that scores buildings using zonal statistics, KNN spatial joins, and temporal aggregation
- Verify 4 Gold tables in your Wherobots catalog with industry-specific risk tiers

**Part 2 — Map Builder AI Agent** (Strands + Bedrock + Wherobots MCP + MapLibre)
- Run a Strands agent that queries the Gold tables through the Wherobots MCP
- Create interactive MapLibre maps from natural language: *"Show buildings with high wildfire risk near Poway"*
- Watch a local map update after every answer; every map is plain GeoJSON plus a MapLibre style

## Architecture

```
Part 1: Data Engineering Agent          Part 2: End-User Map Agent
─────────────────────────────           ──────────────────────────
Developer in Claude Code / Kiro         Strands Agent (Bedrock Claude)
        │                                       │
        ▼                                       ▼
┌─────────────────────┐               ┌───────────────────────┐
│ Wherobots MCP       │               │ Wherobots MCP         │
│ Spatial SQL on      │   ┌───────────┤ + write_layer         │
│ Apache Sedona       │   │  queries  │ + publish_map         │
└────────┬────────────┘   │           └───────────┬───────────┘
         │                │                       │ GeoJSON + map.json
         ▼                ▼                       ▼
 Bronze → Silver → Gold ─────────┐      ┌───────────────────────┐
                                 │      │ MapLibre viewer       │
          org_catalog.gold       │      │ localhost:8765        │
          Iceberg, ~1M × 4  ◀────┘      │ updates after answers │
                                        └───────────────────────┘
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
├── part2_map_agent/
│   ├── agent.py                       # Strands Agent (Bedrock Claude + Wherobots MCP + map tools)
│   ├── run.sh                         # Agent launcher
│   ├── requirements.txt               # Python dependencies
│   ├── CLAUDE.md                      # Part 2 agent guide
│   ├── viewer/index.html              # MapLibre viewer served on localhost:8765
│   └── skills/
│       └── open-mapping/              # Skill: map spec, styling expressions, tier palette
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
| **AI Orchestration** | Amazon Bedrock (Claude Opus 4.8) + Strands Agents SDK | Agent that turns questions into queries and maps |
| **Visualization** | MapLibre GL JS + OpenFreeMap | Interactive maps from GeoJSON and MapLibre styles |

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

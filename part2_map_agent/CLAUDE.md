# Part 2 — Map Builder AI Agent

See the root `CLAUDE.md` for the full project overview.

## Quick Reference

- **Agent**: `agent.py` — Strands Agent (Bedrock Claude) with the Wherobots MCP plus two map tools
- **Skill**: `skills/open-mapping/` (map spec format, styling expressions, tier palette)
- **Viewer**: `viewer/index.html` — MapLibre GL JS on an OpenFreeMap basemap
- **Run**: `./run.sh "your prompt"` or `./run.sh` for interactive mode, then open http://localhost:8765

## Architecture

```
User prompt → Strands Agent → Wherobots MCP (SQL on org_catalog.gold)
                            → write_layer  → viewer/maps/<map_id>/<layer>.geojson
                            → publish_map  → viewer/maps/<map_id>/map.json + maps/current.json
                            → MapLibre viewer on localhost:8765 (updates after every answer)
```

1. The agent explores tables and tests SQL with the Wherobots MCP tools when it needs to.
2. `write_layer(map_id, layer_id, sql)` runs the final query (results capped at 10,000 rows),
   saves it as GeoJSON and returns column stats the agent uses for colour stops.
3. `publish_map(map_id, spec)` validates and writes the map spec, and points
   `maps/current.json` at it. The viewer polls that file and swaps in the new map.

`http://localhost:8765/?map=maps/<map_id>/map.json` opens one fixed map (a permalink).

## Data (Gold Iceberg tables from Part 1)

4 Gold tables in `org_catalog.gold`, 357,263 City of San Diego buildings each (the Part 1 reference area):
- `insurance_exposure` — risk_tier, wildfire/flood/weather factors, triage_priority
- `cre_risk` — risk_tier, acquisition_screen_flag, exposure_magnitude_index
- `capital_markets_signals` — disruption_signal, supply_chain_vulnerability (no risk_tier)
- `energy_asset_risk` — risk_tier, outage_probability, wildfire_ignition_risk

## Configuration (`.env`)

- `WHEROBOTS_API_KEY` — Wherobots MCP access
- `WHEROBOTS_RUNTIME_ID` — SQL session runtime (e.g. `micro`); unset uses the org default
- `GOLD_DB` — catalog database with the Gold tables (default `gold`)
- `BEDROCK_MODEL_ID`, `AWS_DEFAULT_REGION` and AWS credentials — the agent's model
- `MAP_VIEWER_PORT` — viewer port (default `8765`)

# San Diego building risk — map + copilot

An interactive map of the workshop's Gold tables for the City of San Diego (the Part 1 AOI, four
industry lenses), with a chat copilot that drives the map and answers building-level questions by
running spatial SQL on **your own Gold tables** through the Wherobots MCP.

Adapted from Ben Pruden's Colorado property risk explorer (its history is kept in this folder).

## Run it locally (workshop)

```bash
.venv/bin/python part2_map_app/serve.py   # from the repo root, with the venv from Setup (Lab 01)
```

Open http://localhost:8765. The copilot runs on Amazon Bedrock with your workshop AWS
credentials (`BEDROCK_MODEL_ID` in `.env`), and building questions run in your Wherobots
organization with `WHEROBOTS_API_KEY` (on the `WHEROBOTS_RUNTIME_ID` runtime, e.g. `micro`);
neither leaves your laptop. They read `org_catalog.gold`, so finish Part 1 first. The map tiles
are read straight from a public bucket.

Try: *"Which neighbourhoods have the most critical buildings for insurance?"*, *"Show me the
wildfire hotspots around Tierrasanta"*, *"Top 10 buildings by wildfire within 2 miles of Scripps
Ranch"*. The first building question starts Wherobots compute, so it takes about a minute; later
ones take seconds.

## How it works

| Piece | What it is |
|---|---|
| `index.html` | MapLibre GL JS map, OpenFreeMap basemap, and the copilot loop. Tool calls run in the browser |
| PMTiles | `sd_points` (every building as a dot, z9–12, risk drawn on top), `sd_buildings` (footprints, z12+), `sd_hex` (H3 res-8 averages: the view below z9, otherwise the Hexagons toggle), `sd_places` (the city boundary). Tiles are gzipped at publish time |
| `query/gazetteer.js` | Neighbourhood and landmark names the copilot can use as a query centre |
| `copilot.json` | The copilot's system prompt and tools, shared by both chat backends |
| `serve.py` | Local server: static files, `/api/chat` on Bedrock, `/api/query` on the Wherobots MCP |
| `api/chat.js`, `api/query.js` | The same two endpoints for Vercel: the Anthropic API, and the Wherobots MCP over plain HTTP |
| `data/` | `export_sd_app_data.py` runs on Wherobots; `publish.py` copies an export to the public bucket (gzipping tiles); `build_app_data.py` regenerates `copilot.json`, the gazetteer and the data version |

The model never writes SQL: `query_properties` takes a place, a radius, a metric and a limit,
and `/api/query` builds the statement from a fixed template over the four Gold tables.

## Customise it with Kiro

Ask Kiro to change the app, for example: *"add a wildfire threshold slider that filters the
buildings layer"*, *"add a dark basemap toggle"*, *"add a copilot tool that compares two
places"*. Reload the page to see each change.

## Take-home: deploy to Vercel

```bash
npm i -g vercel
cd part2_map_app
vercel deploy
vercel env add ANTHROPIC_API_KEY        # your own key; set a spend limit on it
vercel env add WHEROBOTS_API_KEY        # building queries on your Gold tables
vercel env add WHEROBOTS_RUNTIME_ID     # optional, e.g. micro
vercel deploy --prod
```

The deployed copilot uses `api/chat.js` with your Anthropic key (`ANTHROPIC_MODEL` overrides
the model) and `api/query.js` with your Wherobots key. Set `APP_SECRET` to require an
`x-app-secret` header on both: anyone with the URL could otherwise spend your credits.

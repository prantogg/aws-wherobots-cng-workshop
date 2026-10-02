# San Diego building risk — map + copilot

An interactive map of the workshop's Gold tables for all of San Diego County (1,026,302 buildings,
four industry lenses), with a chat copilot that drives the map and answers building-level
questions by running spatial SQL **in your browser** with SedonaDB (WebAssembly).

Adapted from Ben Pruden's Colorado property risk explorer (its history is kept in this folder).

## Run it locally (workshop)

```bash
.venv/bin/python part2_map_app/serve.py   # from the repo root, with the venv from Setup (Lab 01)
```

Open http://localhost:8765. The copilot runs on Amazon Bedrock with your workshop AWS
credentials (`BEDROCK_MODEL_ID` in `.env`); the credentials never leave your laptop. The map
data is read straight from a public bucket, so nothing else needs setting up.

Try: *"Which places have the most critical buildings for insurance?"*, *"Show me the wildfire
hotspots around Ramona"*, *"Top 10 buildings by wildfire within 3 miles of Julian"*. The first
building-level question downloads the ~10 MB query engine, so it takes a few seconds longer.

## How it works

| Piece | What it is |
|---|---|
| `index.html` | MapLibre GL JS map, OpenFreeMap basemap, and the copilot loop. Tool calls run in the browser |
| PMTiles | `sd_points` (every building as a dot, z9–12, risk drawn on top), `sd_buildings` (footprints, z12+), `sd_hex` (H3 res-7 averages: the view below z9, otherwise the Hexagons toggle), `sd_places` (city boundaries). Tiles are gzipped at publish time: the county view is about 7 MB |
| `query/` | The SedonaDB WASM engine seam: picks the GeoParquet files a query touches (H3 res-5 cells), builds SQL from typed arguments, runs it in the browser |
| `copilot.json` | The copilot's system prompt and tools, shared by both chat backends |
| `serve.py` | Local server: static files plus `/api/chat` on Bedrock |
| `api/chat.js` | The same `/api/chat` for Vercel, on the Anthropic API |
| `data/` | `export_sd_app_data.py` and `export_sd_tiles.py` run on Wherobots; `publish.py` copies an export to the public bucket (gzipping tiles); `build_app_data.py` regenerates `copilot.json`, the gazetteer and the data version |

The model never writes SQL: `query_properties` takes a place, a radius, a metric and a limit,
and `query/sqlbuild.js` builds the statement from a fixed template.

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
vercel deploy --prod
```

The deployed copilot uses `api/chat.js` with your Anthropic key (`ANTHROPIC_MODEL` overrides
the model). Optionally set `APP_SECRET` to require an `x-app-secret` header.

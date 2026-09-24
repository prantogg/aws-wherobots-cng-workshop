# Colorado P&C Risk — Exposure Explorer

MapLibre GL JS + PMTiles map over the Colorado P&C risk tiles. Three zoom-staged
layers: **H3 hex (z0–13) → parcels (z10+) → buildings (z14+)**, with a peril toggle
(wildfire / hail / flood / wind / access), click-to-popup, and the caveat footnotes.

The tiles are **hosted and live** on a public-read S3 bucket, and the app is already
pointed at them — no local tile files needed.

## Run it

⚠️ **Serve on port 8080 or 8090.** The tile bucket's CORS policy allows GET/HEAD from
`http://localhost:8080`, `http://localhost:8090`, and `https://*.vercel.app` **only**.
Any other port (Vite's 5173, Next's 3000, etc.) fails with an opaque CORS error that
*looks* like broken tiles when the bucket is fine.

```bash
cd co-risk-app
python3 -m http.server 8080     # or: npx http-server . -p 8080 -c-1
```

Open **http://localhost:8080/** . That's it.

## Tiles (live, public-read, range + CORS verified)

```
https://co-pc-risk-tiles-benp-uw2.s3.us-west-2.amazonaws.com/tiles/co_hex.pmtiles
https://co-pc-risk-tiles-benp-uw2.s3.us-west-2.amazonaws.com/tiles/co_parcels.pmtiles
https://co-pc-risk-tiles-benp-uw2.s3.us-west-2.amazonaws.com/tiles/co_buildings.pmtiles
```

Set in `TILES_BASE` at the top of the `<script>` in `index.html`. PMTiles reads only the
byte ranges each view needs, so panning Colorado at low zoom pulls a few MB of the hex
archive, not the whole 2.3 GB buildings file.

## Correctness rules baked into the styling (see the two handoffs)

- Score domains are **0–2** (wf/hail) and **0–1** (flood/wind/access), styled with
  explicit `match` — never `interpolate` over an assumed range.
- **Nothing is styled or ranked by dollars.** `parval`/`improv_val` are popup-only
  reference (~63% coverage, county-dependent; El Paso reports $0).
- Access is styled by **`access_score`**, so the 103,807 NULL-distance ("furthest,"
  no station within 25 km) buildings are never greyed out; popups render NULL distance
  as "furthest," not "missing."
- Language is risk **indicators**, not insurability determinations.

- **Optional tile fields, feature-detected:** `land_use` (parcels + buildings) and
  `fema_flood_zone` (parcels) light up the land-use chips/tally split/popup rows and
  the flood-peril "FEMA zones" sub-mode — but only after the tiles are regenerated
  (see `pipelines/co-risk/README.md`); with today's tiles those controls stay hidden.

The H3 layer shades **building density** (its primary styling field); the peril scores
render on parcels and buildings as you zoom in. Counts (hex 24,868 / parcels 2,720,180 /
buildings 2,771,126) are taken from the handoffs; nothing is recomputed.

## Deploy

Deploy the single `index.html` to Vercel (its `*.vercel.app` origin is already in the
bucket's CORS allow-list) — no other hosting needed.

## "Ask the data": spatial SQL in the browser

[`ASK_THE_DATA_PLAN.md`](ASK_THE_DATA_PLAN.md) is the reviewed plan; **the gate passed** and the
feature is wired into the copilot. Ask it *"what are the top 10 properties at risk within 10
miles of downtown Denver?"* and it geocodes the place, runs real spatial SQL over the full
scored-building extract **in your browser**, draws the answer on the map and lists it in a panel.
No query backend, no credentials, no warm cloud session.

The engine is [CereusDB](https://github.com/tobilg/cereusdb) (Apache SedonaDB compiled to WASM,
Apache-2.0), pinned to an exact version and loaded from a CDN **lazily, on the first data
question**. Everything else on this map works whether or not it ever loads.

| file | what it is |
| --- | --- |
| [`query/SPIKE_FINDINGS.md`](query/SPIKE_FINDINGS.md) | the gate result, the engine's sharp edges, and what is still unverified |
| `query/validate.js` | the one allowlist-and-clamp validator, shared by the agent tool and `?q=` links |
| `query/h3cover.js` | H3 resolution selector and the conservative covering set |
| `query/registry.js` | which county part files a query touches, and version pinning |
| `query/sqlbuild.js` | the SQL template and the `co_risk_query` identifier substitution |
| `query/gazetteer.js` | Colorado-only place lookup; unknown places are rejected, never approximated |
| `query/engine.js` | the CereusDB seam: lazy load, per-file registration, engine-death recovery |
| `query/executor.js` | validate to rows, including the exact geodesic radius |
| `query/probe_prereqs.mjs` | live check that the published extract is usable |

Three things in here are not obvious and will bite anyone who changes them:

- **The object store is registered at the ORIGIN, never at a path prefix.** A prefix makes the
  fetch miss, and the miss enters a retry path that calls `Instant::now()`, which panics on wasm
  and kills the engine instance outright.
- **The geometry column needs `ST_SetSRID(ST_GeomFromWKB(...), 5070)`.** The engine does not read
  GeoParquet metadata, so the column arrives as plain binary, and it compares CRS before geometry.
- **EPSG:5070 is equal-area, so a planar radius is wrong by about 0.8%.** The SQL predicate is
  deliberately inflated past that and the exact radius is applied geodesically in the executor,
  so a "within 10 miles" answer never silently drops a building that is inside it.

```bash
cd apps/co-risk-app && python3 -m http.server 8080   # the app
pipelines/co-risk/tests/run_all.sh                   # the suites behind it
```

h3-js is pinned (version, URL and sha256 in `query/h3cover.js`, checked by the validator suite).
The browser loads it from the CDN with a subresource-integrity hash, like MapLibre and pmtiles;
`pipelines/co-risk/tests/fetch_h3.sh` caches that same file for the Node guards, and `run_all.sh`
skips those suites loudly when there is no network rather than failing for the wrong reason.

Serve on **8080 or 8090**: the bucket's CORS does not cover Vite's 5173.

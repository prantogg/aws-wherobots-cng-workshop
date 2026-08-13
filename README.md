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

The H3 layer shades **building density** (its primary styling field); the peril scores
render on parcels and buildings as you zoom in. Counts (hex 24,868 / parcels 2,720,180 /
buildings 2,771,126) are taken from the handoffs; nothing is recomputed.

## Deploy

Deploy the single `index.html` to Vercel (its `*.vercel.app` origin is already in the
bucket's CORS allow-list) — no other hosting needed.

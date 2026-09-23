# "Ask the data" copilot: plan for review

**Status:** plan for review. No code yet. Comment inline before the build starts.

**Goal:** let the co-risk copilot answer questions it cannot answer today, e.g.
*"What are the top 10 properties at risk within 10 miles of downtown Denver?"* by running real
spatial SQL **in the browser**, with no query backend, no credentials, and no warm cloud session.

House rules apply (no em dashes, no personification, modeled vs measured, screening not a verdict).

---

## 1. Why the copilot cannot answer this today

The current copilot (`api/chat.js`) is a **map-control** agent: it calls the Anthropic API and its
tools pan, zoom, switch peril, and recolor. It has no compute backend and no access to the full
dataset. The browser only holds PMTiles, which are generalized tiles for what is on screen. A
"top 10 within 10 miles" needs a global spatial rank over the whole gold table, which tiles cannot
provide. So the copilot needs a way to actually **query the data**.

## 2. Approach: SedonaDB in the browser (`wherobots/labs-sedona-db-wasm`)

Run the query engine client-side. We use the Wherobots labs build of SedonaDB compiled to WASM
(a labs project on the path to public release), which is on-brand (real Apache Sedona in the
browser, our own engine) and does exactly what this needs. Verified from the repo:

- **API:** `register_s3_table(s3_url, table_name)`, `execute_sql(sql) -> JSON`,
  `execute_sql_arrow(sql) -> Arrow IPC`. Runs in a Web Worker (`sedona-worker.js`).
- **Remote GeoParquet over HTTP:** an `ObjectStore` fetches **byte ranges** from S3 via
  `fetch()` + JSPI, so the engine pulls only the row groups a query touches. The extract is a
  directory-partitioned dataset (§4); the tool registers the **selected per-county part files** as
  one `co_risk_query` relation (see the file-to-relation bridge in §3) and never downloads the whole
  dataset.
- **60+ spatial SQL functions** (`ST_DWithin`, `ST_Distance`, `ST_Point`, `ST_Transform`, ...),
  DataFusion 51 + Arrow 57 + geoarrow-rs.
- **Rendering:** results come back as GeoArrow and render with `@geoarrow/deck.gl-layers` over a
  MapLibre basemap. The app already is MapLibre, so results drop straight onto the map.

DuckDB-WASM + spatial remains a fallback if a blocker below proves fatal, but SedonaDB-WASM is the
intended engine.

## 3. Architecture

```
co-risk-app (MapLibre)
  copilot: Anthropic API (api/chat.js) with TOOLS
    ├─ geocode(place)          -> {lat, lon}   (small CO gazetteer, or Overture places)
    └─ query_properties(...)   -> SedonaDB-WASM worker
                                   register selected county part files as `co_risk_query` relation
                                   execute_sql_arrow(SQL)  -> Arrow IPC
                                   -> GeoArrow -> MapLibre source + deck.gl layer + list panel
```

**File-to-relation bridge.** The extract is a directory of per-county part files (§4), so the tool
turns the **selected** county files (those intersecting the query circle) into the relation the SQL
references, using only the documented `register_s3_table` API and **no DDL** (the engine's
`CREATE VIEW` support is not assumed): the tool registers each selected county file as
`co_risk_query_<fips>`, and the SQL builder substitutes the **identifier `co_risk_query` only**
(name-level, no alias attached) with the parenthesized derived table
`(SELECT * FROM co_risk_query_08001 UNION ALL SELECT * FROM co_risk_query_08013 ...)` at
query-build time. The caller keeps its own alias, so the worked example's `FROM co_risk_query b`
becomes `FROM (SELECT * FROM co_risk_query_08001 UNION ALL ...) b`; the derived table never carries
its own `AS b`, which would collide with the existing `b` alias and produce `AS b b`. If the
engine's `register_s3_table` also accepts a directory or glob, that is an optional optimization the
phase-3 spike may adopt, but the subquery-substitution path needs no engine capability beyond what
§2 lists. Either way the relation the SQL sees is exactly the intersecting counties, which is what
bounds the read.

The agent translates the natural-language question into a `geocode` call and a bounded
`query_properties` call (center, radius, metric, limit). The tool runs locally and returns rows plus
provenance; results become a map layer and a ranked list. **The tool result then completes the
Anthropic round-trip:** the client sends the `tool_result` (the rows and provenance) plus the
conversation state back through `api/chat.js` to the API as the second turn, and Claude writes the
summary from that. Without that second turn the worker could render results but the model would be
left with an unanswered tool call. No server query path, no key for the data, no cloud session.

**CRS is explicit** so distances are real metres, not degrees. The extract stores geometry in
**EPSG:5070** (a metre-based equal-area CRS for the contiguous US), and the query transforms the
input lon/lat point into 5070 before any distance test, so `ST_DWithin(..., 16093.4)` is 16,093.4
metres, not degrees.

**Partition pruning is explicit, not wished for.** `ST_DWithin` is not a Parquet statistics filter,
so on its own the engine would read geometry from every partition. The tool therefore computes a
**conservative superset** of H3 cells covering the query circle and emits a literal
`h3_res IN (...)` predicate the reader can prune on **before** any distance math. "Conservative
superset" is load-bearing: the prefilter must include every cell the circle *touches*, so it uses a
covering polyfill (cells that intersect the circle, not cells whose centroid is inside it) or,
equivalently, polyfills the circle buffered outward by one cell diameter. A centroid-containment
polyfill would omit boundary cells and silently drop valid rows; the exact `ST_DWithin` after it
removes the extra cells' non-matching rows, so the superset costs a little scan, never a missed
building. **The H3
resolution is chosen from `radius_m` so the covering-cell count stays bounded**, because a fixed
res-7 explodes at large radii (a ~5.16 km2 cell needs ~3,900 cells to cover the 80 km clamp, and
~150 even for the 10-mile example). v1 rule: pick the **finest** H3 resolution whose covering set is
<= ~64 cells for the given radius (so roughly res-7 under ~8 km, res-6 to ~20 km, res-5 beyond),
which keeps the cell count bounded **and** the prefilter tight; only when no allowed resolution fits
under the cap does it fall back to the `county IN (...)` prefilter. The county fallback is a
conservative superset too, the same way the H3 set is: it is **every county whose extent intersects
the query circle**, not just the county containing the center, so a large-radius query near a county
line does not drop buildings in the neighboring county. Finest-under-cap avoids dragging a giant
res-5 partition in to answer a 1 km query. The extract is therefore partitioned so multiple resolutions can prune (store `h3_5`,
`h3_6`, `h3_7`, and `county`). The phase-3 spike profiles the range-read to confirm the prune
actually happens across the whole clamped radius range rather than assuming it.

**Result contract includes display geometry.** Query geometry is EPSG:5070, but a MapLibre GeoJSON
source needs WGS84, so the SELECT returns `lon`/`lat` (or a 4326 geometry) via `ST_Transform` back
to EPSG:4326 for rendering; the 5070 geometry stays server-side for the distance test only.

Worked example for the Denver question:

```sql
WITH pt AS (
  SELECT ST_Transform(ST_Point(-104.9903, 39.7392), 'EPSG:4326', 'EPSG:5070') AS g
)
SELECT b.building_id, b.composite, b.wf_score, b.hail_score, b.flood_score, b.wind_score,
       b.access_score, b.county,
       ST_X(ST_Transform(b.geom_5070, 'EPSG:5070', 'EPSG:4326')) AS lon,   -- for MapLibre (WGS84)
       ST_Y(ST_Transform(b.geom_5070, 'EPSG:5070', 'EPSG:4326')) AS lat,
       ST_Distance(b.geom_5070, pt.g) AS dist_m               -- both operands in EPSG:5070 metres
FROM co_risk_query b, pt
WHERE b.h3_6 IN (/* tool-computed res-6 cells covering the 10-mile circle */) -- radius-matched prune
  AND ST_DWithin(b.geom_5070, pt.g, 16093.4)                              -- 10 miles = 16093.4 m
ORDER BY b.composite DESC, b.building_id ASC   -- stable tie-break so a versioned link reproduces exactly
LIMIT 10;
```

## 4. The query extract (pipeline)

A new export step emits a **lean GeoParquet** beside the PMTiles, on the same public-read tiles
bucket so the browser can range-read it.

**Provenance is open by construction.** The extract carries only Overture-derived identifiers and
geometry plus Wherobots-computed scores. It carries **no Regrid attributes** (no address,
`parcelnumb`, `improv_val`, `usedesc`, or Regrid geometry), so nothing licensed is redistributed on
a public bucket (CLAUDE.md rule 5). Columns:

`building_id (Overture), geom_5070 (building centroid, EPSG:5070), composite, wf_score, hail_score,
flood_score, wind_score, access_score, county, h3_5, h3_6, h3_7` (multiple H3 resolutions so the
tool can prune at a resolution matched to `radius_m`, see §3).

- **Grain is buildings** (Overture `building_id`), which is the fine grain co-risk already scores,
  plus `h3_7` for an aggregated view. "Properties" therefore means scored buildings, not Regrid
  parcels. This is the settled grain for v1 (see §8, which no longer lists it as open).
- If a human-readable place label is ever needed for display, resolve it client-side from the
  in-catalog Overture addresses layer at query time, never by baking Regrid address into the public
  file.
- **Physical layout (so both prune, not just one).** A single Parquet object cannot give tight
  row-group statistics on `h3_5`/`h3_6`/`h3_7` *and* `county` at once, so the extract is a
  **directory-partitioned dataset**, not one file:
  `co_risk_query.v<YYYYMMDD>/county=<FIPS>/part.parquet` (one part file per Colorado county, 64 of
  them). Within each county file, rows are sorted by `(h3_5, h3_6, h3_7)` so row-group min/max
  statistics prune at every H3 resolution.
  - **County-fallback path** reads only the county part files whose extent intersects the query
    circle. The browser tool selects those files by URL directly (it already computes the covering
    set), so the fallback reads a bounded handful of counties, never a statewide scan, regardless of
    whether the engine does its own directory pruning.
  - **H3 path**: the covering cells localize to a few counties, so the tool registers just those
    county files and the within-file `(h3_5, h3_6, h3_7)` ordering row-group-prunes to the matching
    cells.
  - Phase-3 (§7) verifies both paths stay under the 25% bytes-read budget against this layout; if
    the engine cannot prune a partitioned dataset by directory, the tool's explicit per-county file
    selection still bounds the read.
- Static between monthly runs. **Each run writes an immutable, versioned dataset directory**
  (`co_risk_query.v<YYYYMMDD>/`) plus a concrete **`manifest.json` object at the directory root**
  (listing the county part files and row counts) and updates a `latest` pointer. The `manifest.json`
  is the object §6's version-existence check HEADs, since S3 has no real directory to HEAD; the
  export step must write it. The version id is part of the query result and the shareable link
  (see §6) so a shared query reproduces against the exact extract it ran on, not whatever is current
  later. Retain prior versions for the link lifetime.

## 5. The agent

Two Anthropic tools, whose **schemas** are declared in the `api/chat.js` model turn but whose
**execution lives in the browser**. `api/chat.js` only proxies the Anthropic request/response and
the tool-call schemas; it never touches the engine. When the model emits a tool call, the browser
client (not the serverless function) runs it: **SQL construction and all allowlist/clamp validation
happen in the browser-side executor that owns the SedonaDB-WASM worker** (§2, §3), because that is
the only side that can invoke the local WASM engine. The model never emits SQL that reaches the
engine; it fills typed arguments and the browser executor builds the SQL.

- `geocode(place)`: resolve "downtown Denver" to a point. v1 uses a small CO gazetteer (cities plus
  a few landmarks); later, query an Overture-places extract in the same engine.
- `query_properties({center, radius_m, metric, limit})`, with every argument validated tool-side:
  - **`metric` is a fixed allowlist**, not a free string. It maps tool-side to a column, one of
    `{composite, wf_score, hail_score, flood_score, wind_score, access_score}`. Raw model output is
    never interpolated into an `ORDER BY`/column slot; an unknown value is rejected. (SQL has no
    bind syntax for identifiers, so the allowlist is the parameterization for the column.) Every
    metric template orders by the chosen column **plus a stable secondary key**
    (`ORDER BY <metric> DESC, building_id ASC`), so tied scores resolve deterministically and a
    versioned deep-link reproduces the same rows and markers every time.
  - **`radius_m` and `limit` are validated in the tool**, one unambiguous rule per input,
    independent of what the model or a hand-edited link asks. `radius_m`: **reject** anything
    non-numeric, non-finite (NaN/Infinity), zero, or negative outright; **clamp** a finite value
    above `80000` down to `80000` (the upper bound keeps partition pruning effective). `limit`:
    **reject** anything non-integer, non-finite, zero, or negative outright; **clamp** an integer
    above `50` down to `50` (the upper bound keeps the deck.gl layer sane on a phone-class browser).
    In short: reject-or-clamp is decided by which end, and only the upper end is clamped; there is no
    lower bound to clamp toward. The validation lives in the tool, not the prompt.
  - **`center` is validated on every invocation**, agent-originated and deep-link alike, through the
    same canonical validator described in §6: `lon` and `lat` must be finite with `lon` in
    `[-180, 180]` and `lat` in `[-90, 90]`, else rejected before it reaches `ST_Point`/`ST_Transform`.
    A geocoded center passes this too; the model calling `query_properties` directly does not get an
    exemption. The tool then transforms the validated center to EPSG:5070 as in §3.

Guardrails carried from the app:
- **Modeled/inherited disclosure (CLAUDE.md rules 2 and 4).** A `building_id` next to a score reads
  as a per-building assessment, so the tool result, the Claude system prompt, and the ranked-panel
  copy must all carry each returned score's grain and provenance: the peril scores are
  **centroid-sampled and partly modeled/inherited** (hazard sampled at the building point, some
  perils inherited from coarser resolution), `access_score` is a **0/1 cohort flag, not a
  measurement**, and the composite is a **screening sum, not a per-building loss estimate**.
  "Screening" alone is not enough; the modeled-vs-measured label travels with every row.
- "At risk" = the composite (0-7). Present it as a **screening** ranking, never a loss or
  insurability determination.
- Never rank by dollars (value coverage is 63% and county-dependent). Note that dollars are not
  even in the extract, so the tool cannot rank by them.
- `access_score` stays **0/1** (1 = the furthest/no-station cohort), matching the app. It is not the
  nullable field: the value that is NULL and rendered as "furthest" is the raw *distance* field, not
  the score. If a raw distance column is ever added to the extract, NULL there is rendered "furthest"
  and never sorted or displayed as missing. `access_score` itself is never NULL.

## 6. Rendering + deep-link

Results become a MapLibre GeoJSON/GeoArrow source: up to `limit` markers, fly to the area, a ranked
side panel with per-peril scores and distance.

**The deep-link must carry the query, not just the camera.** The existing `?lat/lon/zoom` restores
only the map viewport, so a recipient would not see the ranked results. So the shareable link
encodes the **query state** (`?q=…` with center, `radius_m`, `metric`, `limit`) plus the
**extract version id** it ran against, and the app **re-runs the query on load** to reproduce the
markers and panel against that exact version (§4), not whatever is current later. A plain
`?lat/lon/zoom` link remains supported but is explicitly viewport-only.

**On load, every `?q=` param is untrusted and re-validated.** A pasted or hand-edited link must not
bypass the guardrails. So on load all params pass through the **same allowlist and clamp function**
as an agent-originated call before any SQL or fetch, covering every field, not just three:
- `metric`: allowlisted (reject unknown);
- `radius_m <= 80000`, `limit <= 50`: clamped;
- `center`: `lon` and `lat` parsed as finite numbers with `lon` in `[-180, 180]` and `lat` in
  `[-90, 90]`; anything else is rejected before it reaches `ST_Point`/`ST_Transform`;
- `version`: format-validated `^\d{8}$` and existence-checked by HEAD-ing the concrete
  **`co_risk_query.v<version>/manifest.json`** object the export writes (§4), not a directory (S3
  has none) and not a single `.parquet`, before the tool selects that version's per-county part
  files. If the pinned version
  404s, the app does **not** silently rerun against `latest` (that would break the link's
  reproducibility promise); it surfaces a visible "this shared result used data version <v>, which
  is no longer retained; showing latest instead" notice and only then loads `latest`. A malformed
  version is rejected outright
  (the bucket is public-read, so the worst case is reading another public object, but it still goes
  through validation).
The URL is an input to `query_properties`, never a shortcut around it, so `?radius_m=999999999` or a
hand-edited `center`/`version` is clamped or rejected, not honored.

## 7. Build phases

1. **Plan** (this doc): review.
2. **Extract:** pipeline export of the `co_risk_query.v<date>/county=<FIPS>/part.parquet`
   directory-partitioned dataset (§4; open-provenance columns only, EPSG:5070 geometry, rows sorted
   by `(h3_5, h3_6, h3_7)` within each county file), **write the `manifest.json` object** at the
   version-directory root (for §6's existence check) and update `latest`, + upload to the tiles
   bucket (CORS already allows the app origins).
3. **Engine spike:** vendor/pin the labs WASM build, load it in a worker in the app, and prove the
   **file-to-relation bridge** (§3): register the intersecting-county part files as the
   `co_risk_query` relation (directory/glob if supported, else per-file `UNION ALL` view) and run a
   hardcoded Denver query returning rows in the browser. Determining which registration mode the
   engine supports is part of this gate, with explicit acceptance criteria:
   - **JSPI fallback correctness:** on a browser without JSPI, the app detects it and the fallback
     (in-memory extract or DuckDB-WASM) returns the same top-10 as the JSPI path, or fails loudly;
     it never silently returns wrong/empty results.
   - **Cell-count bound:** the resolution selector keeps the covering set `<= ~64` cells at 1 km,
     10 mi, and the 80 km clamp; verify no query emits a res-7 predicate at large radius.
   - **CRS/units:** the 10-mile query returns only buildings within 16,093.4 m (spot-check
     `dist_m` max), confirming 5070 metres, not degrees.
   - **Clamp/reject enforcement (both ends):** oversized inputs (`radius_m=1e9`, `limit=100000`)
     clamp to the upper bound; malformed or lower-end inputs (`radius_m=0/-5/NaN`, `limit=0/-1/2.5`),
     an unknown `metric`, an out-of-range `center` (`lon=200`), and a bad `version` are **rejected**,
     from both agent tool calls and hand-edited `?q=` links, not just oversized ones.
   - **Boundary superset soundness, both paths:** a building just inside `radius_m` but in a
     covering-cell at the circle's edge is still returned (H3 path), **and** a large-radius query
     centered near a county line still returns buildings across the line (county-fallback path),
     confirming both prefilters are true supersets (§3) and neither drops boundary rows.
   - **Range-read profile (with a budget), every path:** profile one query on each pruning path
     (a res-7 small radius, the res-6 10-mile example, a res-5 large radius, and a county-fallback
     query near a county line), and each must fetch **< 25% of the full extract size** (proposed);
     any path that pulls most of the file fails the gate. Budgeting only the 10-mile/res-6 path
     would let the res-5 or county-fallback paths read the whole dataset undetected.
4. **Agent tools:** declare the `geocode` + `query_properties` **tool schemas** in the `api/chat.js`
   model turn, and implement their **execution in the browser executor** (§5): SQL construction and
   the allowlist/clamp validation live there, not in the serverless function. Wire them with the
   allowlist and
   clamps above and the result contract.
5. **Render:** map layer + list panel + summary + deep-link.

## 8. Risks and open items (resolve before or during the phase-3 spike)

- **JSPI browser support is the gating risk.** The S3 fetch bridge uses JavaScript Promise
  Integration. JSPI is recent (shipped in Chromium-based browsers in 2025); Safari and Firefox
  support must be checked. If a target browser lacks JSPI, remote GeoParquet range-reads will not
  work there. **This is the phase-3 go/no-go.** Fallback: pre-load a smaller extract into memory,
  or DuckDB-WASM.
- **57.5 MB wasm.** Serve with brotli/gzip (drops it to roughly 10-15 MB), cache aggressively,
  and lazy-load only when the user first asks a data question, inside the worker. Measure real
  first-load on a cold cache before committing to it in the UX.
- **License.** The labs repo has no LICENSE file today. It is intended for public release; still, a
  license must be added and confirmed before we ship it embedded in a customer-facing app. Owner:
  coordinate with the labs-sedona-db-wasm maintainers.
- **In-memory single-partition MVP.** The browser build is in-memory, single-partition, no spill.
  Keep the extract lean and partitioned; do not point it at the full 2.4 GB buildings tiles.
- **Geocoding scope.** This is the Colorado co-risk app (64 CO counties, no California data), so the
  v1 gazetteer is **Colorado-only** (CO cities plus a few landmarks like downtown Denver);
  free-form place input needs the Overture-places path. Confirm v1 scope. (Earlier "CA/CO" wording
  was a template leftover and has been corrected to CO throughout.)

(The building-vs-parcel grain is settled in §4 as buildings and is no longer an open item; the
Regrid-licensing question is resolved by excluding Regrid attributes from the extract.)

## 9. Why it is worth it

This turns the copilot from "drive the map" into "ask the data," and it is **engine-in-the-browser
with zero backend**, the same pattern transferring to all four flagship apps. It also puts our own
SedonaDB-WASM labs build in a real customer-facing setting, which is exactly the public direction
that build is heading.

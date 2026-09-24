# Engine findings: spatial SQL in the browser for "ask the data"

Phase 3 of [`../ASK_THE_DATA_PLAN.md`](../ASK_THE_DATA_PLAN.md), the go/no-go gate, plus what
building phases 4 and 5 on top of it turned up.

Assessed 2026-09-22 against `wherobots/labs-sedona-db-wasm`, then re-assessed 2026-09-23 against
**`@cereusdb/standard` 0.2.0**, which is what the app now uses.

---

## Verdict: **GO**, on CereusDB rather than the labs build.

The Denver question runs end to end in a real browser, against a real engine, over remote
GeoParquet read by byte range, using the shipped `validate.js` / `h3cover.js` / `registry.js` /
`sqlbuild.js` unmodified.

One criterion is still genuinely open (the read budget at production scale) and it cannot be
closed until the extract existed. It has since been generated and measured; see Criterion 9.

### A retraction

An earlier version of this document called anonymous bucket LIST a blocker: it claimed table
registration required one, so the `GetObject`-only tiles bucket could not work. That was
inferred from reading the labs `em_fetch_list` without running anything. DataFusion calls
`store.head()` first for a concrete file URL and only falls back to `list()` on `NotFound`, and
anonymous HEAD returns `200`. Nothing needed working around. A blocker read out of source
without running it is a hypothesis.

## Why CereusDB and not the labs build

The labs build is paused upstream pending a general `object_store` WASM connector, has no
LICENSE and publishes no artifact, so it cannot be pinned or embedded. CereusDB is a WASM build
of the same engine (Apache SedonaDB on DataFusion) on npm under Apache-2.0. Measured, not
assumed: EPSG:5070 resolves (PROJ configured at startup, `proj.db` embedded, which the labs
build never did), no JSPI anywhere so the Chromium-only constraint disappears, and 45 MB raw
against 57.5 MB.

⚠️ **The `standard` build is required.** `minimal` omits PROJ, and every `ST_Transform` in the
query template would fail on it.

## Acceptance criteria (plan section 7)

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 1 | Covering set stays within the cell cap at 1 km, 10 mi, the 80 km clamp | **PASS** | `test_query_cover.js`. 1 km res-7/7 cells; 10 mi res-6/37; 40 km res-5/37; 80 km falls back to counties. |
| 2 | No res-7 predicate at a large radius | **PASS** | Same test. res-7 would be 197 cells at 10 mi and 3,823 at 80 km, rejected at both. |
| 3 | Boundary superset, H3 path | **PASS** | 900 probe points per radius across four radii, none outside the cover; the buffered cover is asserted strictly larger than a centroid-only polyfill. |
| 4 | Boundary superset, county-fallback path | **PASS** | A 40 km query 2.6 km from a county line selects both sides; 500 m selects one. |
| 5 | Clamp and reject at both ends, tool call and `?q=` link alike | **PASS** | `test_query_validate.js`. |
| 6 | File-to-relation bridge, no DDL, no alias collision | **PASS, against the engine** | The shipped builder's SQL parses and runs on CereusDB. `FROM co_risk_query b` becomes `FROM (SELECT * FROM co_risk_query_08031) b`. |
| 7 | CRS and units: nothing returned beyond the radius | **PASS, with a caveat** | Denver 10-mile query returns 10 rows, max distance 14,717 m. See *Equal-area distance* below: the caveat is why the exact cut is applied outside SQL. |
| 8 | JSPI fallback correctness | **MOOT** | No JSPI in the artifact. The gating risk in plan section 8 does not exist on this engine. |
| 9 | Range-read profile under 25% of the extract | **PASS for a selective query, N/A otherwise** | Measured on a real county file from the generated extract, below. |

### Criterion 9, measured on the real extract

**This is the single source for these numbers.** The pipeline points here rather than repeating
them, because an earlier version had two tables that disagreed.

Measured through `@cereusdb/standard` against the real Denver county file as the pipeline
produced it (266,279 buildings, 14.87 MB, **237 row groups, ~1,124 rows per group**), a fresh
engine per query so nothing is served from cache.

⚠️ **"Generated" is not "published."** Extract `v20260924` exists in Wherobots managed storage
only. Nothing has been written to the public tiles bucket and the app cannot reach it; the file
measured here was pulled from managed storage through a presigned URL and served locally. The
`latest` pointer does not exist yet.

| query | prefilter | bytes read | time |
| --- | --- | --- | --- |
| 500 m | res-7, 7 cells | **16.8%** | 415 ms |
| 1 km | res-7, 7 cells | **16.8%** | 416 ms |
| 1 km | none | 96.6% | 1,445 ms |
| 5 km | res-7, 33 cells | 96.9% | 1,465 ms |
| 10 mi | res-6, 37 cells | 96.8% | 1,874 ms |

The prefilter is worth about 80 percentage points and 3.5x the speed on a selective query.

⚠️ **The budget is only meaningful for a selective query, and saying otherwise would be
dishonest.** A 10-mile radius over a compact dense county reads essentially the whole county
file whatever the row-group size, because the circle genuinely covers most of the county. That
is not a pruning failure and no extract shape fixes it. What the budget really tests is that a
small query does not drag in a whole county, and that now holds.

**How the row-group budget was chosen, and why it is stated in bytes.** The sweep below was run
by rewriting one real county file locally at several row-group sizes, which is the only way to
vary it directly:

| rows/group | row groups | bytes read, 1 km |
| --- | --- | --- |
| ~12,100 | 22 | 39.8% |
| ~5,000 | 54 | 29.9% |
| ~2,500 | 107 | 21.4% |

That pointed at roughly 2,500 rows per group. **Spark cannot be asked for a row count**: it
budgets row groups by UNCOMPRESSED buffered bytes. An earlier version of the constant divided
the byte budget by a COMPRESSED bytes-per-row figure and therefore asked for about 2.2x more
rows per group than it got, while the comment claimed the target had been achieved.

The budget is now stated as what it controls, `PARQUET_BLOCK_BYTES = 137_500`, and the achieved
sizing is recorded from the real run rather than predicted: Denver 237 groups (~1,124
rows/group), El Paso 259 groups (~1,122). That lands finer than the 2,500 the sweep suggested,
which is why the real file reads **16.8%** where the sweep's 2,500-row variant read 21.4%.

⚠️ **The constant is empirical.** 137,500 is the leftover of the wrong arithmetic (2,500 x 55),
kept because the sizing it produces was then measured and is good, not because the calculation
was sound. To retune, use the observed ratio rather than a compressed bytes-per-row: 137,500
bytes gives ~1,124 rows per group, so roughly **122 uncompressed bytes per row**. That ratio is
a property of this column set and moves if the columns do, so re-measure after any change.

---

## Equal-area distance: why the exact radius is applied outside SQL

EPSG:5070 is NAD83 / Conus Albers, which is **equal-area, not equidistant**. Measured against
geodesic distance across Colorado:

| direction | scale |
| --- | --- |
| north-south | **+0.67% to +0.78%** (over-measures) |
| east-west | **−0.57% to −0.73%** (under-measures) |

So `ST_DWithin(..., 16093.4)` is not a 10-mile circle on the ground. North-south it falls about
**123 m short**, which would drop buildings that are genuinely inside the radius with no error
anywhere: the silent undercount the floors guardrail exists to prevent.

There is no `ST_DistanceSpheroid` in this build, so the projection cannot be avoided in SQL.
Instead:

1. `sqlbuild.js` inflates the planar predicate by `PLANAR_SLACK` (1%), past the worst measured
   distortion, so the SQL filter is a conservative **superset** in every direction, and
   over-fetches so the next step has rows to spare;
2. `executor.js` measures each returned point geodesically from the query centre and applies
   `radius_m` **exactly**.

The distance the user sees is a true ground distance, not a projected one.

---

## Engine behaviours that will bite anyone changing this code

Each of these is a loud comment at the line that depends on it; the short version:

1. **Register the object store at the ORIGIN, never a path prefix** (`engine.js`). At a prefix
   the fetch misses, and the miss enters `object_store`'s retry path, which calls
   `std::time::Instant::now()` -- unimplemented on `wasm32-unknown-unknown`. It panics and takes
   the whole instance down (`RuntimeError: unreachable`). Upstream
   `arrow-rs-object-store#624`. Measured directly: origin registers, prefix panics.
2. **That panic is unrecoverable and not limited to registration.** Any transport error the retry
   path sees can reach it, and a panicked instance stays broken. So files are HEAD-checked before
   registration, and a trap marks the engine dead so the next question rebuilds it.
3. **Relation names carry the extract VERSION** (`registry.js`). The engine caches a
   registration by relation name, so naming it after the county alone means that when a new
   extract is published mid-session, or a shared link pins a different version, the cached name
   already maps to the previous version's file. The old rows come back reported under the new
   version id: wrong data, right-looking provenance, no error. `co_risk_query_v<version>_<fips>`
   makes a different version a different relation, and `engine.js` additionally refuses to serve
   a relation name that was registered to a different file.
4. **GeoParquet metadata is ignored** (`sqlbuild.js`). The geometry column arrives as
   `BinaryView`; it needs `ST_GeomFromWKB`, then `ST_SetSRID(..., 5070)`, because the engine
   compares CRS before geometry and a decoded WKB has none.

---

## Found while wiring it into the app

- **A symbol layer cannot render without a `glyphs` endpoint.** Rank numbers originally used
  `text-field`; MapLibre rejected the layer outright, it never drew, and the only trace was a
  console error. The offline suites could not see it; the headless-Chrome render test caught it
  in CI. Rank numbers are DOM markers now.
- **The engine binary is hash-checked before it runs.** `import()` cannot carry a
  subresource-integrity hash, so `engine.js` fetches the binary, digests it, compares it against
  a pinned SHA-256 cross-checked between the npm tarball and the CDN, and refuses to start on a
  mismatch. 48 ms to hash, 328 ms for the whole load in a browser. ⚠️ The small JS glue is still
  loaded by `import()` and is not verifiable this way: a narrow residual gap, not an absent one.
- **Distance is measured on the WGS84 ellipsoid** (Vincenty), not a sphere. Haversine carries its
  own error of the same order as the projection error this is correcting.
- **Timings under `--virtual-time-budget` are meaningless.** It reported the engine taking
  "600,012 ms" and cut the page off mid-run. Every number here is real wall clock over CDP.

## Verified against the real extract

The whole path has now been run against real data rather than a synthetic fixture: the pipeline
generated all 64 counties from the 2,771,126-row spine in 169 s, and a real county file was
queried through `@cereusdb/standard`, returning real Overture building ids at correct WGS84
coordinates, all inside the radius, ordered by composite then `building_id`.

Two defects only a real write could expose, both fixed:

- **The geometry was not readable by the engine.** Writing a Sedona geometry column persists
  Spark's `GeometryUDT`, whose serialization is not standard WKB: 24 bytes of an 8-byte header
  plus two float64, against 21 bytes starting `01 01000000`. `ST_GeomFromWKB` would have
  rejected every row, and Spark's own Comet reader could not read the file back either
  ("Unsupported data type: GeometryUDT"). `ST_AsBinary` emits standard WKB in a plain binary
  column and fixes both. **The synthetic fixture hand-wrote correct WKB, so the test was more
  correct than the pipeline it validated** -- the same shape of error as the self-grading box
  test above.
- **`verify_written` could not see what it was verifying.** Reading the version root makes Spark
  infer a `county` partition column from the directory name that collides with the real column
  inside the file and wins, typed as an int, so `08031` came back as `8031`. It now reads each
  county file with `basePath` pinned to its own directory, which is also how the browser reads.

## Superseded files, removed

`spike.html`, `spike-worker.js`, `fetch-count.js` and `pipelines/co-risk/tests/test_query_bytecount.js`
were built for the labs engine and stopped working against CereusDB (`spike.html` called
`engine.jspiSupported()` and `PINNED_COMMIT`, neither of which exists now). Nothing linked to
them and no test runner loaded them, so they were deleted in their own PR. Recover them from
git history if the labs build is ever re-evaluated.

---

## What is still unverified

- **Safari and Firefox.** Everything here ran in Node and in headless Chrome. The package uses
  no JSPI and the transport is ordinary wasm-bindgen async, so there is no known reason it would
  differ, but "no known reason" is not a test.
- **Cold-load cost in front of a real user.** The engine is ~6 MB brotli and loads lazily on the
  first data question. Locally it is 328 ms end to end, but that is a local fetch; it has not
  been measured on a cold cache over a slow connection.
- **Firefox and Safari** remain the only genuinely untested surface.

---

## Reproducing

See the "Ask the data" section of [`../README.md`](../README.md) for how to run the app and the
suites. Read any result as a **screening** ranking: the composite is a sum of five narrow scores
(0-7), hazard is sampled at the building centroid with several perils inherited from coarser
resolution, `access_score` is a 0/1 cohort flag rather than a measurement, and the building spine
is a floor rather than a census.

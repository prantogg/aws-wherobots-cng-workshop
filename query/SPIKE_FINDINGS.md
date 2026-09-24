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
closed until the extract is published. It is listed as open rather than waved through.

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
| 9 | Range-read profile under 25% of the extract, every path | **OPEN** | Pruning demonstrably works (below), but the budget cannot be measured until the real extract exists. |

### Criterion 9, honestly

Measured with a fresh engine per query, so the object store's cache could not make a later query
look free, against a 200k-row, 1.9 MB synthetic county file:

| query | prefilter | bytes read |
| --- | --- | --- |
| 1 km | res-7, 7 cells | **59.5%** |
| 1 km | none | 98.7% |
| 10 mi | res-6, 37 cells | 98.9% |
| 80 km | county fallback | 98.7% |

The 1 km case proves the `h3_* IN (...)` predicate genuinely prunes row groups. The 10-mile case
shows no benefit because the test file is 200k points inside a 30 km disk, so 37 res-6 cells
touch every row group. **That is a property of the test data, not a result.** A real county file
spans a whole county.

What it did settle is a pipeline defect: row-group size. The test file had 10 row groups, so one
group is already 10% of it, and Spark sizes row groups by BYTES against rows this narrow, which
would have put a whole county in one group and made pruning impossible by construction.
`40_generate_query_extract.py` now sets `ROWS_PER_GROUP` and **fails the run** if the largest
county file comes out with fewer than two groups.

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

## Superseded files still on the branch

`spike.html`, `spike-worker.js`, `fetch-count.js` and `tests/test_query_bytecount.js` were built
for the labs engine and no longer work against this one: `spike.html` calls
`engine.jspiSupported()` and `PINNED_COMMIT`, neither of which exists now. They are dead, nothing
links to them, and no test loads them. They are deleted in a separate follow-up PR rather than
here, because removing them costs 27 KB of pure deletion and this PR was over the reviewer's
200 KB diff limit, where a skip is not a pass.

---

## What is still unverified

- **Safari and Firefox.** Everything here ran in Node and in headless Chrome. The package uses
  no JSPI and the transport is ordinary wasm-bindgen async, so there is no known reason it would
  differ, but "no known reason" is not a test.
- **Cold-load cost in front of a real user.** The engine is ~6 MB brotli and loads lazily on the
  first data question. Locally it is 328 ms end to end, but that is a local fetch; it has not
  been measured on a cold cache over a slow connection.
- **The read budget at production scale** (criterion 9, above).

---

## Reproducing

See the "Ask the data" section of [`../README.md`](../README.md) for how to run the app and the
suites. Read any result as a **screening** ranking: the composite is a sum of five narrow scores
(0-7), hazard is sampled at the building centroid with several perils inherited from coarser
resolution, `access_score` is a 0/1 cohort flag rather than a measurement, and the building spine
is a floor rather than a census.

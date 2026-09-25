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

⚠️ **These numbers were taken before the extract was published.** At the time, `v20260924`
existed in Wherobots managed storage only, and the file measured here was pulled through a
presigned URL and served locally. It has since been published to the public tiles bucket:
`tiles/query/co_risk_query.latest.json` points at `v20260924` (`published_utc`
2026-09-24T18:17:00Z), and anonymous GET of its `manifest.json` returns 200 (both checked
2026-09-24). The *Range reads* section below was measured against that published copy on S3.

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

## Range reads: why a first query was serial, and the fix

Measured 2026-09-24 in headless Chrome 153 on macOS 26.5, through `window.mapTools.query_properties`
(the real app path: HEAD, register, SQL, geodesic cut), against the published `v20260924` extract
on S3, a fresh browser profile per run, with the engine already loaded so only the query is
timed. The link measured 13.5 MB/s (a `curl` of the 16.3 MB El Paso file). Every request was
counted over CDP `Network`.

### What each request is

Boulder 1 km on the live app (`21952ad`), 44 requests:

| # | request | size | when |
| --- | --- | --- | --- |
| 1 | `HEAD` from `engine.js` (reachability check) | | register |
| 1 | `HEAD` from DataFusion (object size) | | register |
| 1 | `GET` of the last 512 KiB (`metadata_size_hint` = 524288): the footer (178 KB of Thrift for 128 row groups) plus the page indexes before it | 525 KB | register |
| 1 | `HEAD` from DataFusion | | query |
| 40 | `GET`, one per row group that survives `h3_7` min/max pruning, all 10 projected columns coalesced into one range (~62 KB each) | 2.5 MB | query |

The footer is read once and cached for the session. So a first query in a county is one footer
read plus one read per surviving row group, and it was the row-group reads that were serial:
each started only after the previous one finished, 60 to 150 ms apart, maximum concurrency 1
(2 counting the page's own HEAD).

### Why they were sequential

Two causes, and both had to go:

1. **`target_partitions` is 1 in this build** (read from `information_schema.df_settings`), so
   DataFusion scans a file as one stream that requests a row group, decodes it, and only then
   requests the next. The engine's JS fetch queue allows 16 in flight; nothing ever asked for
   more than one.
2. **The query point was a `WITH pt AS (...)` cross join, which SedonaDB plans as
   `SpatialJoinExec`.** Raising `target_partitions` split the file into byte-range partitions
   (EXPLAIN showed 8 file groups), but the spatial join drained them one at a time, so the reads
   stayed serial (still 41 GETs, concurrency 2, 4.5 to 5.6 s at 4, 8 and 16 partitions).

With the point inlined as a constant expression the plan is a plain `FilterExec` over the scan
under `SortExec TopK` per partition and `SortPreservingMergeExec`, and the partitions read
concurrently. The planner folds the point to the same WKB literal either way.

### Fix

- `sqlbuild.js`: the query point is inlined instead of a `pt` CTE.
- `engine.js`: at load, `SET datafusion.execution.target_partitions = 16`,
  `datafusion.optimizer.repartition_file_min_size = 0` and
  `datafusion.optimizer.enable_round_robin_repartition = false`.

⚠️ **The third setting is a safety setting.** Without `repartition_file_min_size = 0` the file
(smaller than the 10 MB default) is not split, and the planner instead inserts a
`RepartitionExec RoundRobinBatch(8)` above the scan. In this WASM build that query did not
complete within 40 s, where the serial plan takes 4 s. The same happened with the old CTE shape
at 16 partitions. With round-robin repartition off, an unsplit scan runs serially instead of
hanging. Checked at 1 km, 500 m, 10 mi, 40 km (12 counties) and the 80 km county fallback (21
counties): all complete.

### Guard: `pipelines/co-risk/tests/browser_check_parallel_reads.mjs`

A real-browser check, not a stub. It serves the app on localhost:8080, runs Boulder 1 km through
`query_properties` in real headless Chrome against the published extract on S3, twice, each in
a fresh profile: once as `engine.js` configures the engine, once with
`SET datafusion.execution.target_partitions = 1` on the live instance (the pre-fix serial
read). It reads the three settings back from the live engine's
`information_schema.df_settings` and fails unless they are 16 / 0 / false, the configured run's
max concurrent extract GETs is above 1, the serial run's is exactly 1, and both return the same
10 building ids in the same order. It needs network, so it is run by hand and is not in
`run_all.sh`: `node pipelines/co-risk/tests/browser_check_parallel_reads.mjs`.

Run 2026-09-25, Chrome 153, macOS 26.5, on this branch:

| run | target_partitions | GETs | max GET concurrency | bytes | ms | ids (sha1) |
| --- | --- | --- | --- | --- | --- | --- |
| configured | 16 | 41 | 12 | 3.01 MB | 2,017 | `7b5b8a0691d6` |
| serial | 1 | 41 | 1 | 3.01 MB | 4,486 | `7b5b8a0691d6` |

PASS, 9 of 9. The same script run with `engine.js` and `sqlbuild.js` reverted to `main`
reported target_partitions 1, repartition_file_min_size 10485760, round-robin true and max GET
concurrency 1, and FAILED 4 checks: it catches the regression, which a stub asserting the SET
strings would not, because it only passes if the engine actually applies them.

### Before and after

Live app `21952ad` (before) against this branch served locally on port 8080 (after); same S3
extract, same network, 2 runs each, the matched rows identical in both (building ids hashed and
compared, in order).

| query | requests | GETs | max concurrency | bytes | ms before | ms after |
| --- | --- | --- | --- | --- | --- | --- |
| Boulder 1 km | 44 | 41 | 2 → 12 | 3.02 MB | 4,504 / 4,848 | **1,980 / 1,924** |
| El Paso (Colorado Springs) 1 km | 85 | 82 | 2 → 16 | 5.56 MB | 9,190 / 8,375 | **2,511 / 2,384** |
| Denver 10 mi (4 counties) | 870 | 858 | 5-7 → 16 | 54.8 MB | 89,569 / 89,169 | **14,184 / 14,399** |
| Greeley 500 m | 62 | 59 | 2 → 15 | 4.12 MB | 6,539 | **1,990** |

Request counts and bytes do not change: the fix changes when the reads happen, not which. The
partition count was swept on El Paso 1 km: 8 partitions 2,428 / 2,779 ms, 16 partitions
2,511 / 2,384 ms, 32 partitions 2,540 / 2,484 ms (capped at 16 in flight by the fetch queue);
Denver 10 mi at 32 was 15,718 ms. 16 is kept.

### Levers measured and not taken

- **`registerParquetTable({ targetPartitions })` alone** (the only option besides
  `fileExtension` in the package's `.d.ts`): no effect, 41 serial GETs, 3,989 ms. The session
  `SET` is what the planner reads.
- **A JS-side prefetch** of the exact ranges, issued in parallel when the app's HEAD fires and
  served back to the engine's `fetch` from memory. Measured as a ceiling by replaying the ranges
  a previous run requested, which is perfect knowledge a real implementation would have to get
  by parsing the Thrift footer and re-implementing DataFusion's row-group pruning in JS:
  Boulder 1 km 1,414 / 1,541 ms, El Paso 1 km 2,220 / 2,227 ms, identical rows. That is at most
  about 0.5 s better than the partitioning fix, for a footer parser plus a pruning copy that
  must agree with the engine forever. Not worth it.
- **Fewer columns.** All 10 projected columns are used: 9 are returned to the app and `h3_7` is
  the prefilter. Per row group (Boulder footer) `building_id` is 40.8 KB and `geom_5070` 18.9 KB
  of ~61 KB; the 7 score and label columns together are about 1.1 KB. Nothing worth dropping.
- **Whole-file GET** (`register_parquet_buffer`): rejected earlier, 2.7x the bytes.

### Recommended extract change (not made: regenerating needs a Wherobots runtime)

**Sort each county file by `h3_7` alone, not by `(h3_5, h3_6, h3_7)`.** The current sort does not
order `h3_7`: the res-6 cell a point falls in is not always the parent of its res-7 cell (6.4% of
Boulder rows), so `h3_7` descends 88 times down the file and row-group min/max ranges overlap.
In Boulder 40 of 128 row groups pass the 1 km `h3_7` stats test and all 40 are read, while only
22 actually hold one of the 7 cells.

Measured with the real engine in headless Chrome on the real Boulder file rewritten three ways
(pyarrow, ~1,125 rows per group) and served locally with Range support, so bytes and requests
are comparable and times are not:

| layout | 500 m GETs / bytes | 1 km GETs / bytes | 10 mi GETs / bytes |
| --- | --- | --- | --- |
| published file | 41 / 3.00 MB | 41 / 3.00 MB | 129 / 8.41 MB |
| same order, pyarrow rewrite (writer control) | | 39 / 2.97 MB | |
| sorted by `h3_7` | 20 / 1.74 MB | **22 / 1.86 MB** | 130 / 8.70 MB |

Same rows in every layout. That is 38% fewer bytes and about half the requests for a selective
query, and no change at 10 mi, which reads the whole county either way. Not yet measured: a res-6
query on a county large enough for res-6 pruning to matter under the new sort.

Secondary, if bytes matter more later: `building_id` is a 36-character UUID string and 67% of
every row group. A 16-byte binary encoding is the next lever to measure; it is a schema change
(the app would format it back), not a tuning change.

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
5. **Range reads are concurrent only with the scan settings AND a join-free query**
   (`engine.js`, `sqlbuild.js`). Reintroducing a `pt` CTE makes the reads serial again, and
   turning round-robin repartition back on can make an unsplit scan hang. See *Range reads*.

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

- **Safari: still unverified, blocked on one setting only Ben can change.** Safari 26.5.2 is
  installed, but `safaridriver` refuses a session: "You must enable 'Allow remote automation' in
  the Developer section of Safari Settings to control Safari via WebDriver." Nothing was done to
  work around it. Once it is on, the same query can be driven through `safaridriver`.
- **Firefox: now verified.** Firefox 155.0.1, headless, driven over its own WebDriver BiDi
  endpoint (`--remote-debugging-port`, no geckodriver), fresh profile per run, through
  `window.mapTools.query_properties` against the published extract on S3. Every run returned the
  same rows as Chrome (building ids hashed and compared in order). Before is the live app
  (`21952ad`); after is the concurrent-reads change (PR #61) served on localhost:8080.

  | query | GETs | max concurrency | bytes | ms |
  | --- | --- | --- | --- | --- |
  | Boulder 1 km, live | 41 | 1 | 3.02 MB | 4,499 |
  | Boulder 1 km, PR #61 | 41 | 12 | 3.01 MB | 1,548 / 1,611 |
  | El Paso 1 km, live | 82 | 1 | 5.56 MB | 9,008 |
  | El Paso 1 km, PR #61 | 82 | 16 | 5.56 MB | 2,188 |
  | Denver 10 mi, PR #61 | 858 | 16 | 54.7 MB | 13,448 |

  One run per row, except Boulder with PR #61, which was run twice (two runs, two timings).
  Engine load in a fresh Firefox profile against the live app: 1,166 and 1,068 ms (two runs).
- **Cold-load cost: now measured, and the engine is larger on the wire than this document said.**
  Earlier text called it "~6 MB brotli". Measured: jsdelivr serves `cereusdb_bg.wasm` as brotli
  at **10.63 MB** (`curl` with `Accept-Encoding: br`, `content-length: 10633260`; gzip is
  12.29 MB), and a cold load moves 10.65 MB across 5 CDN requests. Headless Chrome 153, fresh
  profile, live app, timing `CoRiskQuery.engine.load()` (glue import, wasm fetch, SHA-256,
  compile):

  | link | load time |
  | --- | --- |
  | unthrottled (13.5 MB/s measured) | 1,124 / 1,050 ms |
  | CDP-throttled 10 Mbps, 50 ms latency | 9,903 ms |
  | CDP-throttled 2 Mbps, 150 ms latency | 46,449 ms |

  The throttled rows are Chrome's network emulation on this Mac, not a real mobile link. They
  show the download dominates on a slow link: warming the engine when the copilot opens hides
  about 10 s on a 10 Mbps connection only if the user takes that long to ask.

---

## Reproducing

See the "Ask the data" section of [`../README.md`](../README.md) for how to run the app and the
suites. Read any result as a **screening** ranking: the composite is a sum of five narrow scores
(0-7), hazard is sampled at the building centroid with several perils inherited from coarser
resolution, `access_score` is a 0/1 cohort flag rather than a measurement, and the building spine
is a floor rather than a census.

# Engine spike findings: SedonaDB-WASM for "ask the data"

Phase 3 of [`../ASK_THE_DATA_PLAN.md`](../ASK_THE_DATA_PLAN.md), the go/no-go gate.
Assessed 2026-09-22 against `wherobots/labs-sedona-db-wasm` at commit
`872041f3e443feb87fada56e0ce9b4603fb0c8c7`.

---

## Verdict: **NO-GO today.** Three blockers, none of them in the query design.

The bridge design in plan section 3 survives contact with the engine's real API, and the parts
that do not need the engine are built, tested and passing. The gate does not close because the
engine **cannot be run against this app's data as either side is configured right now**:

- the public tiles bucket denies the bucket listing that the engine's table registration issues,
  so no file can be registered (**B1**);
- there is no published build of the engine to load, and the labs repo still has no licence, so
  nothing can be embedded in a customer-facing app yet (**B2**);
- the extract itself is written but not published, because publishing is an owner decision
  (**B3**).

None of the three is a design problem and none is expensive. B1 is a bucket-policy line or a
small engine patch; B2 is a CI artifact step plus a licence decision; B3 is one pipeline run.
**Re-run the gate after B1 and B2 clear** using the harness and probe described below. Do not
treat this NO-GO as a verdict on SedonaDB-WASM: it is a verdict on today's hosting.

**What is NOT claimed here.** The engine was never executed in this work. Four of the nine
acceptance criteria are marked BLOCKED below and they are not passes. A criterion nobody could
evaluate reads as "fine" only if we let it.

---

## Acceptance criteria (plan section 7)

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 1 | Cell-count bound: covering set stays at or under ~64 cells at 1 km, 10 mi, 80 km clamp | **PASS** | `test_query_cover.js`. 1 km res-7 / 7 cells; 10 mi res-6 / 37; 40 km res-5 / 37; 80 km no stored resolution fits, so the county path. |
| 2 | No res-7 predicate at a large radius | **PASS** | Same test. res-7 would be 197 cells at 10 mi and 3,823 at 80 km, and is rejected at both. |
| 3 | Boundary superset, H3 path | **PASS** | 900 probe points per radius at 99.9%, 97%, 75%, 40% and 5% of the radius, across four radii: none falls outside the cover. Also asserts the buffered cover is strictly larger than a centroid-only polyfill, which is the failure being guarded. |
| 4 | Boundary superset, county-fallback path | **PASS** | `test_query_cover.js`: a 40 km query 2.6 km from a county line selects both counties and no unrelated one; a 500 m query selects one. |
| 5 | Clamp and reject at both ends, from a tool call and from a hand-edited `?q=` link | **PASS** | `test_query_validate.js`, 67 checks. `radius_m=1e9` and `limit=100000` clamp; `0`, `-5`, `NaN`, `2.5`, an unknown metric, `lon=200` and a malformed version are rejected; the deep link goes through the same function. |
| 6 | File-to-relation bridge: registration by file, identifier substitution, no DDL, no alias collision | **PASS** *(as a construction)* | `test_query_bridge.js`. `FROM co_risk_query b` becomes `FROM (SELECT * FROM co_risk_query_08001 UNION ALL SELECT * FROM co_risk_query_08031) b`; `co_risk_query_08001` is left alone; no `CREATE VIEW`. The SQL has not been parsed BY the engine (see B1/B2). |
| 7 | CRS and units: the 10-mile query returns nothing beyond 16,093.4 m | **BLOCKED** | Needs the engine. Related risk **R1** below: `ST_Transform` to EPSG:5070 is unverified in the WASM build. |
| 8 | JSPI fallback correctness: a non-JSPI browser returns the same top 10 or fails loudly | **BLOCKED** | Detection is implemented and unit-tested (`engine.js`, feature-detected, never sniffed from a user-agent) and the loader stops rather than starting without JSPI. The *equivalence* half needs a running fallback. |
| 9 | Range-read profile: res-7, res-6, res-5 and county-fallback paths each read under 25% of the extract | **BLOCKED** | Needs the engine and a published extract. The instrumentation exists and is itself tested (`fetch-count.js`, `test_query_bytecount.js`): the worker counts every byte the engine fetches, since the requests originate inside WASM and app-side counting would report zero and look like a pass. A response whose size cannot be established is recorded as UNMEASURED rather than as zero, so an uncounted fetch cannot flatter the budget. |

**What "as a construction" does and does not cover.** It means the statement is built correctly
from validated inputs; it does not mean a registered table would satisfy it. That gap already hid
one real defect: the extract was written with Spark's `partitionBy("county")`, which encodes the
FIPS in the directory name and strips `county` out of the file. Reading through the partitioned
root puts it back, so every Spark-side check passed, while a per-file registration (the only kind
B1 permits) would have produced a table with no `county` column and failed every query the bridge
builds. The write is now explicit per county and `verify_written()` re-reads the files to prove
the column survived. The lesson generalises: until criterion 7 runs, the engine's view of this
schema is inferred, not observed.

---

## Blockers

### B1. Table registration needs a bucket LISTING, and the tiles bucket denies it

This is the one that actually stops the spike.

`register_s3_table` builds a DataFusion `ListingTable`, and the engine's fetch bridge issues an
S3 `ListObjectsV2` for schema inference even when the URL names a single object. From the labs
source, `src/em_fetch.js`:

```js
// S3 ListObjectsV2 API -- fetch only 1 key to avoid slow full-bucket
// listings. DataFusion calls list() for schema inference and query
// execution; a single file is sufficient for WASM demos.
var listUrl = baseUrl + '?list-type=2&max-keys=1&prefix=' + encodeURIComponent(prefix);
```

The co-risk tiles bucket grants anonymous `s3:GetObject` on `tiles/*` and nothing else, on
purpose (`20_upload_s3.py`: anonymous LIST, PUT and DELETE all 403). Measured 2026-09-22:

```
GET  /tiles/co_hex.pmtiles  Range: bytes=0-15        -> 206  Accept-Ranges: bytes
GET  /?list-type=2&max-keys=1&prefix=tiles/          -> 403  AccessDenied
```

The engine's own e2e test registers
`s3://overturemaps-us-west-2/release/.../part-00028-....parquet`, and that bucket answers the
same listing with **200**. So the remote-GeoParquet path is proven only against a bucket that
permits anonymous listing. Ours does not, and range reads working is not enough.

Two ways out, in order of preference:

1. **Patch the engine** to skip `list()` when the URL names a concrete object (a HEAD gives the
   size, which is what the listing is used for). This keeps the bucket's read-only posture intact
   and fixes it for every future app on this bucket. Owner: labs-sedona-db-wasm maintainers.
2. **Grant `s3:ListBucket`** scoped to the `tiles/query/*` prefix. Cheaper, and it widens what
   anonymous callers can enumerate on a bucket that today publishes nothing but what it means to.
   Owner: Ben.

Re-check with `node apps/co-risk-app/query/probe_prereqs.mjs`, which reports exactly this.

### B2. There is no engine build to load, and no licence to embed it under

`pkg/sedona_db.wasm` (57.5 MB) and its glue are build outputs, gitignored in the labs repo. The
labs CI builds them for its Playwright job but uploads only the test report, so there is no
artifact to pin. Building locally needs emsdk, a Rust `wasm32-unknown-emscripten` toolchain,
cmake and a from-source GEOS/PROJ/S2 dependency build; none of that is on this machine, and it is
not the kind of thing to install inside a gate run.

Two things needed, both small:

1. an `actions/upload-artifact` step for `pkg/` in the labs CI (or a tagged release), so the
   build can be **pinned by digest** rather than rebuilt per developer;
2. a `LICENSE` file. The plan already flags this. It has to be settled before the engine ships
   inside anything customer-facing, which this app is.

`engine.js` takes `wasmBase` as a parameter precisely so this can be satisfied by pointing at a
published artifact without a code change.

### B3. The extract is written but not published

Phase 2 lands in this PR as
[`40_generate_query_extract.py`](../../../pipelines/co-risk/export/40_generate_query_extract.py)
and [`41_upload_query_extract.py`](../../../pipelines/co-risk/export/41_upload_query_extract.py),
and neither has been run: generating it is a WherobotsDB job over 2.77 M buildings and publishing
it writes to the public bucket, both of which are the owner's call. So there is no
`co_risk_query.v<date>/` to read. This is a sequencing fact, not a defect, and it is listed as a
blocker because criteria 7 and 9 cannot be evaluated without it.

---

## Risks found while reading the engine (not yet blockers)

**R1. `ST_Transform` to EPSG:5070 is unverified in this build, and the whole CRS story rests on
it.** `sedona_proj`'s kernels are registered in `src/lib.rs`, but `configure_global_proj_engine`
is never called and no `proj.db` is preloaded into the Emscripten filesystem. The labs demo page
exercises exactly one transform, 4326 to 3857, and no test covers any EPSG lookup. If 5070 needs
a database lookup that is not present, the query fails outright (loud, fine) or, in the worse
case, some code path returns degrees and `ST_DWithin(..., 16093.4)` silently matches most of
Colorado. **Criterion 7 is the check for this, and it must be run before anything ships.** The
fallback, if PROJ cannot resolve 5070 in the browser, is to store the geometry in a CRS the
engine can handle without a lookup, or to pre-transform the query point outside the engine and
pass 5070 coordinates in directly; both are extract-side changes, not design changes.

**R2. First load is 57.5 MB of WASM.** Brotli takes it to roughly 10-15 MB, which is still a
large download to put in front of someone's first question. The plan's lazy-load-on-first-data-
question approach is right; the number to measure at re-gate is cold-cache time to first row, not
the compressed size.

**R3. This copy of the worker will drift.** `spike-worker.js` is derived from the labs
`sedona-worker.js` because the original hardcodes `/pkg/` and has no byte accounting. If the labs
protocol changes, this file keeps speaking the old one and the failure will look like an engine
bug. Re-check it against the pinned commit before trusting a new measurement.

---

## What the engine's API confirmed about the plan

The plan was written against the labs README. Reading the source agrees with it on every point
the bridge depends on, which is why the NO-GO is about hosting rather than design:

- `register_s3_table(s3_url, table_name, region)`, `execute_sql_arrow(sql)` and `execute_sql(sql)`
  are the exported C ABI, run from a Web Worker. No DDL entry point, which is exactly why the
  plan's substitution approach avoids `CREATE VIEW`.
- Registration takes an **`s3://` URL plus a region**, not the `https://` URL the app uses
  elsewhere; the engine rebuilds the virtual-hosted URL itself. `engine.js#httpsToS3` does that
  conversion in one place, because handing it an `https://` URL fails inside the engine with a
  parse error that names neither the bucket nor the file.
- Registration **can** accept a directory (`ListingTableUrl` parses a prefix), which the plan
  listed as an optional optimisation. B1 removes it from consideration for this bucket: the
  directory form needs a real listing, while per-file registration needs only the listing bug
  fixed or the permission granted. Per-file also keeps the read bounded without depending on
  engine-side directory pruning, which was the plan's reason for preferring it.

---

## Reproducing this

```bash
# the parts that need no engine and no credentials. Two of the four suites need the pinned
# h3-js build, which fetch_h3.sh caches on first run; without a network they skip loudly.
pipelines/co-risk/tests/run_all.sh          # includes the four ask-the-data suites

# the hosting prerequisites, live against the bucket (this is the re-gate check)
node apps/co-risk-app/query/probe_prereqs.mjs

# the harness, in a browser. CORS allows 8080/8090, not Vite's 5173.
cd apps/co-risk-app && python3 -m http.server 8080
#   http://localhost:8080/query/spike.html                        criteria 1-6 + the Denver SQL
#   http://localhost:8080/query/spike.html?wasmBase=<engine>/pkg/  adds the engine attempts
```

The harness reports PASS, FAIL or **BLOCKED**, and BLOCKED is never coloured as a pass.

---

## What is ready the moment the blockers clear

Everything except the engine call and the rendering: the validator, the H3 resolution selector and
covering set, the county selection, the version pinning rule, the SQL template and the
file-to-relation substitution, all unit-tested. The Denver statement the gate asks for is built
today and printed by the harness:

```sql
WITH pt AS (
  SELECT ST_Transform(ST_Point(-104.9903, 39.7392), 'EPSG:4326', 'EPSG:5070') AS g
)
SELECT b.building_id, b.composite, b.wf_score, b.hail_score, b.flood_score,
       b.wind_score, b.access_score, b.county,
       ST_X(ST_Transform(b.geom_5070, 'EPSG:5070', 'EPSG:4326')) AS lon,
       ST_Y(ST_Transform(b.geom_5070, 'EPSG:5070', 'EPSG:4326')) AS lat,
       ST_Distance(b.geom_5070, pt.g) AS dist_m
FROM (SELECT * FROM co_risk_query_08031 UNION ALL SELECT * FROM co_risk_query_08059) b, pt
WHERE b.h3_6 IN (/* 37 res-6 cells covering the 10-mile circle */)
  AND ST_DWithin(b.geom_5070, pt.g, 16093.4)
ORDER BY b.composite DESC, b.building_id ASC
LIMIT 10;
```

Read it as a **screening** ranking. The composite is a sum of five narrow scores (domain 0-7),
hazard is sampled at the building centroid and several perils are inherited from coarser
resolution, `access_score` is a 0/1 cohort flag rather than a measurement, and the building spine
is a floor rather than a census. That disclosure ships inside `manifest.json` so it travels with
every row instead of being re-worded per surface.

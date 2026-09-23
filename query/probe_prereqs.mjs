/**
 * Re-gate probe: are the engine's hosting prerequisites met yet?
 *
 * The phase-3 blockers in SPIKE_FINDINGS.md are properties of the BUCKET and of what is published
 * on it, not of the query code, so they can flip without anything in this repo changing. This
 * script asks the bucket directly. It is the thing to run before re-opening the gate, and after
 * any bucket-policy change.
 *
 * It is NOT in tests/run_all.sh on purpose: that suite runs with no network by design, and a
 * network check there would fail for the wrong reason on a plane.
 *
 *   node apps/co-risk-app/query/probe_prereqs.mjs [version]
 *
 * Exit code is 0 when every prerequisite holds and 1 when any does not, so it can gate a later
 * automated re-run.
 */

const BUCKET = "co-pc-risk-tiles-benp-uw2";
const REGION = "us-west-2";
const BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`;
const PREFIX = "tiles/query/";
const APP_ORIGIN = "http://localhost:8080";   // one of the origins the bucket's CORS allows

const version = process.argv[2] || null;
let failed = 0;

function report(name, ok, detail) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "\n          " + detail : ""}`);
  if (!ok) failed++;
}

/** A probe that dies on a DNS hiccup is less legible than the prerequisites it reports on, so
 *  every check runs inside this and a thrown request becomes a FAIL line like any other. */
async function probe(name, fn) {
  try { await fn(); }
  catch (err) { report(name, false, `request failed: ${err && err.message ? err.message : err}`); }
}

// 1. Ranged GET: what the engine's ObjectStore actually does for every row group.
await probe("anonymous ranged GET returns 206 with Accept-Ranges", async () => {
  const r = await fetch(BASE + "tiles/co_hex.pmtiles", { headers: { Range: "bytes=0-15" } });
  report("anonymous ranged GET returns 206 with Accept-Ranges",
         r.status === 206 && r.headers.get("accept-ranges") === "bytes",
         `status ${r.status}, Accept-Ranges ${r.headers.get("accept-ranges")}`);
});

// 2. CORS: the browser is the client, so a correct object with no CORS header is unreadable.
//    ⚠️ THE MATCH MUST BE EXACT. S3 echoes back the allowed origin it matched, so a header
//    naming some OTHER origin means the browser would still refuse this one. Accepting any
//    non-empty value reports CORS as ready while the harness cannot read a byte, and the label
//    ("CORS allows <origin>") makes that false pass doubly misleading.
await probe(`CORS allows ${APP_ORIGIN}`, async () => {
  const r = await fetch(BASE + "tiles/co_hex.pmtiles",
                        { headers: { Range: "bytes=0-15", Origin: APP_ORIGIN } });
  const allow = r.headers.get("access-control-allow-origin");
  report(`CORS allows ${APP_ORIGIN}`, allow === APP_ORIGIN || allow === "*",
         `Access-Control-Allow-Origin: ${allow}`);
});

// 3. BLOCKER B1. The pinned engine build calls ListObjectsV2 during table registration, even for
//    a single object (labs src/em_fetch.js, em_fetch_list). The bucket policy grants GetObject
//    only, so registration cannot succeed while this is denied.
await probe("anonymous ListObjectsV2 is permitted (engine registration prerequisite)", async () => {
  const r = await fetch(`${BASE}?list-type=2&max-keys=1&prefix=${encodeURIComponent(PREFIX)}`);
  report("anonymous ListObjectsV2 is permitted (engine registration prerequisite)",
         r.status === 200,
         r.status === 403
           ? "403 AccessDenied - this is blocker B1. Either grant s3:ListBucket scoped to this "
             + "prefix, or patch the engine to skip list() for a single-object registration."
           : `status ${r.status}`);
});

// 4. Is there anything to query yet? The extract is phase 2 and is not published by running this.
await probe("a published extract exists", async () => {
  const r = await fetch(BASE + PREFIX + "co_risk_query.latest.json");
  if (r.status === 200) {
    const latest = await r.json();
    report("a published extract exists", true, `latest = v${latest.version}`);
    const v = version || latest.version;
    const m = await fetch(`${BASE}${PREFIX}co_risk_query.v${v}/manifest.json`);
    if (m.status === 200) {
      const manifest = await m.json();
      report(`v${v} manifest is readable and complete`,
             (manifest.counties || []).length === 64,
             `${(manifest.counties || []).length} counties, ${manifest.rows} rows`);
    } else {
      report(`v${v} manifest.json is HEAD-able (the version-existence check)`, false,
             `status ${m.status}`);
    }
  } else {
    report("a published extract exists", false,
           `latest pointer is ${r.status} - on this bucket a missing key reads as 403 rather `
           + "than 404, because anonymous LIST is denied. Phase 2 has not been published yet, so "
           + "there is nothing for the engine to read.");
  }
});

console.log(failed ? `\n${failed} prerequisite(s) not met` : "\nall prerequisites met");
process.exit(failed ? 1 : 0);

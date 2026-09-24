/**
 * Is the published extract actually usable by the browser?
 *
 * The app reads the extract straight from the public tiles bucket, so the things that break it
 * are properties of the BUCKET and of what is published there, not of this repo. This script
 * asks the bucket directly. Run it after publishing a new extract version, and any time the
 * app says it cannot find data.
 *
 * It is deliberately NOT in tests/run_all.sh: that suite runs with no network by design, and a
 * live check there would fail for the wrong reason on a plane.
 *
 *   node apps/co-risk-app/query/probe_prereqs.mjs [version]
 *
 * Exits non-zero if anything the app depends on is missing.
 */

const BUCKET = "co-pc-risk-tiles-benp-uw2";
const REGION = "us-west-2";
const BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`;
const PREFIX = "tiles/query/";
// One of the origins the bucket's CORS allows. Vite's 5173 is NOT on that list.
const APP_ORIGIN = "http://localhost:8080";

let failed = 0;
function report(name, ok, detail) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "\n          " + detail : ""}`);
  if (!ok) failed++;
}
async function probe(name, fn) {
  try { await fn(); }
  catch (err) { report(name, false, `request failed: ${err && err.message ? err.message : err}`); }
}

const pinned = process.argv[2] || null;
let version = pinned;

// 1. Is anything published at all?
await probe("a published extract exists", async () => {
  const r = await fetch(BASE + PREFIX + "co_risk_query.latest.json", { cache: "no-store" });
  if (r.status !== 200) {
    return report("a published extract exists", false,
      `latest pointer is ${r.status}. On this bucket a missing key reads as 403 rather than ` +
      `404, because anonymous LIST is denied. Run pipelines/co-risk/export/41_upload_query_extract.py.`);
  }
  const latest = await r.json();
  version = version || latest.version;
  report("a published extract exists", true, `latest = v${latest.version}`);
});

if (!version) {
  console.log("\nnothing published, so the remaining checks have nothing to test");
  process.exit(1);
}

// 2. The manifest is the object a shared link HEADs, and the browser reads its county bboxes
//    to decide which files to register. An incomplete one silently narrows every query.
await probe(`v${version} manifest`, async () => {
  const r = await fetch(`${BASE}${PREFIX}co_risk_query.v${version}/manifest.json`);
  if (r.status !== 200) return report(`v${version} manifest`, false, `status ${r.status}`);
  const m = await r.json();
  const n = (m.counties || []).length;
  report(`v${version} manifest lists all 64 counties`, n === 64, `${n} counties, ${m.rows} rows`);
  report("manifest geometry CRS is the metre-based one the query assumes",
         m.crs === "EPSG:5070", String(m.crs));
  const missing = ["h3_5", "h3_6", "h3_7", "county", "geom_5070"]
    .filter((c) => !(m.columns || []).includes(c));
  report("manifest declares the columns the query selects", missing.length === 0,
         missing.join(", "));
});

// 3. Ranged GET is what the engine does for every row group.
await probe("anonymous ranged GET on a county file", async () => {
  const url = `${BASE}${PREFIX}co_risk_query.v${version}/county=08031/part.parquet`;
  const r = await fetch(url, { headers: { Range: "bytes=0-3" } });
  const magic = new Uint8Array(await r.arrayBuffer());
  report("anonymous ranged GET on a county file",
         r.status === 206 && String.fromCharCode(...magic) === "PAR1",
         `status ${r.status} (need 206), magic ${String.fromCharCode(...magic)}`);
});

// 4. The browser is the client, so a readable object with no CORS header is unreadable.
//    ⚠️ THE MATCH MUST BE EXACT. S3 echoes back the origin it matched, so a header naming some
//    OTHER origin means this one would still be refused.
await probe(`CORS allows ${APP_ORIGIN}`, async () => {
  const r = await fetch(`${BASE}${PREFIX}co_risk_query.v${version}/county=08031/part.parquet`,
                        { headers: { Range: "bytes=0-3", Origin: APP_ORIGIN } });
  const allow = r.headers.get("access-control-allow-origin");
  report(`CORS allows ${APP_ORIGIN}`, allow === APP_ORIGIN || allow === "*",
         `Access-Control-Allow-Origin: ${allow}`);
});

// 5. The engine is loaded from a CDN at a pinned version. If that 404s, no query can run.
await probe("the pinned query engine is fetchable", async () => {
  const mod = await import("./engine.js").catch(() => null);
  const url = mod ? mod.MODULE_URL
    : "https://cdn.jsdelivr.net/npm/@cereusdb/standard@0.2.0/dist/index.js";
  const r = await fetch(url, { method: "HEAD" });
  report("the pinned query engine is fetchable", r.ok, `${r.status} ${url}`);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nthe extract is usable by the app");
process.exit(failed ? 1 : 0);

/**
 * Resolve the pinned h3-js build for Node, so the guarding tests exercise the SAME build the
 * browser loads.
 *
 * In the browser, `h3` is a global from the pinned CDN script tag, exactly like MapLibre and
 * pmtiles elsewhere in this app. Node has no script tag and this repo has no build step and no
 * package.json, so the tests fetch that same pinned file into a gitignored cache and point here.
 *
 * ⚠️ THE POINT IS THAT THERE IS ONE BUILD, NOT TWO. A CDN copy for the app plus some other copy
 * for the test is two sources that drift, and the drift shows up as a test passing against a cell
 * layout the app does not have. The version and the integrity hash are declared once, in
 * h3cover.js, and `tests/fetch_h3.sh` reads them out of that file rather than restating them.
 *
 * A missing cache is a LOUD failure with the command to fix it, never a quiet fallback to some
 * other h3 that happens to be installed.
 */
const fs = require("fs");
const path = require("path");

const CACHE_DIR = process.env.H3_JS_CACHE ||
                  path.join(__dirname, "..", "..", "..", ".cache");

function resolve() {
  if (process.env.H3_JS_PATH) return process.env.H3_JS_PATH;
  const src = fs.readFileSync(path.join(__dirname, "h3cover.js"), "utf8");
  const m = /H3_JS_VERSION\s*=\s*"([^"]+)"/.exec(src);
  if (!m) {
    throw new Error("H3_JS_VERSION not found in h3cover.js - renamed? The pinned version lives " +
                    "there and nowhere else.");
  }
  return path.join(CACHE_DIR, "h3-js-" + m[1] + ".umd.js");
}

const file = resolve();
if (!fs.existsSync(file)) {
  throw new Error(
    "the pinned h3-js build is not cached at " + file + "\n" +
    "    Fetch it first (needs network, once):  pipelines/co-risk/tests/fetch_h3.sh\n" +
    "    tests/run_all.sh does this for you and skips loudly when there is no network.");
}

module.exports = require(file);

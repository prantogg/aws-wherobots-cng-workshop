/**
 * Spike worker: SedonaDB-WASM plus byte accounting.
 *
 * Derived from sedona-worker.js in wherobots/labs-sedona-db-wasm at commit
 * 872041f3e443feb87fada56e0ce9b4603fb0c8c7. Two deliberate differences from the labs original,
 * both required by the phase-3 gate in ASK_THE_DATA_PLAN.md section 7:
 *
 *   1. COUNTING fetch (fetch-count.js), installed BEFORE the glue is loaded, so the range-read
 *      budget ("< 25% of the full extract size") is measured rather than asserted. The fetches
 *      originate inside WASM, so this is the only place they can be seen; counting in app code
 *      would report zero and look like a pass. A response whose size cannot be established is
 *      recorded as UNMEASURED rather than as zero bytes, and `stats().sound` says so.
 *   2. `wasmBase` is a parameter, not the hardcoded '/pkg/'. This app does not serve the engine
 *      from its own root.
 *
 * ⚠️ THIS IS A COPY, AND COPIES DRIFT. If the labs worker protocol changes, this file keeps
 * speaking the old one and fails in ways that look like engine bugs. Re-check it against the
 * pinned commit before trusting a new measurement.
 */

var mod = null;

// Byte accounting, installed BEFORE the engine glue loads so nothing it fetches escapes the
// count. The implementation lives in fetch-count.js so it can be exercised by a test; a counting
// shim that is only reachable inside a Web Worker is a measurement nobody has checked.
importScripts("fetch-count.js");
var counters = self.CoRiskFetchCount.newCounters();
self.fetch = self.CoRiskFetchCount.countingFetch(self.fetch.bind(self), counters);

function stats() {
  var snap = JSON.parse(JSON.stringify(counters));
  // A total that silently omitted an unmeasurable response would read as a better result than
  // the truth, so soundness travels with the number.
  snap.sound = self.CoRiskFetchCount.isMeasurementSound(counters);
  return snap;
}

function post(msg, transfer) { postMessage(msg, transfer || []); }

onmessage = async function (e) {
  var d = e.data || {};
  var id = d.id;

  try {
    if (d.action === "init") {
      if (mod) { post({ id: id, type: "done" }); return; }
      var base = d.wasmBase || "/pkg/";
      post({ type: "debug", stage: "loading glue from " + base });
      importScripts(base + "sedona_db.js");
      mod = await SedonaDB({
        locateFile: function (path) { return base + path; },
        mainScriptUrlOrBlob: base + "sedona_db.js"
      });
      post({ type: "debug", stage: "module-ready" });
      post({ id: id, type: "done" });
      return;
    }

    if (!mod) { post({ id: id, type: "error", error: "engine not initialised" }); return; }

    if (d.action === "stats") {
      post({ id: id, type: "stats", stats: stats() });
      return;
    }

    if (d.action === "register_s3_table") {
      var ptr = await mod.ccall("register_s3_table", "number",
                                ["string", "string", "string"],
                                [d.s3Url, d.tableName, d.region], { async: true });
      var result = mod.UTF8ToString(ptr);
      mod.ccall("free_string", null, ["number"], [ptr]);
      // The engine's own message is the diagnosis (an S3 403 on LIST reads very differently from
      // a schema mismatch), so it is passed through verbatim rather than summarised.
      if (result === "OK") post({ id: id, type: "done" });
      else post({ id: id, type: "error", error: result });
      return;
    }

    if (d.action === "execute_sql_arrow") {
      var bufPtr = await mod.ccall("execute_sql_arrow", "number", ["string"], [d.sql],
                                   { async: true });
      var len = mod.HEAPU8[bufPtr] | (mod.HEAPU8[bufPtr + 1] << 8) |
                (mod.HEAPU8[bufPtr + 2] << 16) | (mod.HEAPU8[bufPtr + 3] << 24);
      if (len === 0) {
        // Error frame: [0u32][err_len u32 LE][err_bytes...]
        var errLen = mod.HEAPU8[bufPtr + 4] | (mod.HEAPU8[bufPtr + 5] << 8) |
                     (mod.HEAPU8[bufPtr + 6] << 16) | (mod.HEAPU8[bufPtr + 7] << 24);
        var errBytes = mod.HEAPU8.slice(bufPtr + 8, bufPtr + 8 + errLen);
        mod.ccall("free_buffer", null, ["number", "number"], [bufPtr, 8 + errLen]);
        post({ id: id, type: "error", error: new TextDecoder().decode(errBytes) });
        return;
      }
      var ipc = mod.HEAPU8.slice(bufPtr + 4, bufPtr + 4 + len);
      mod.ccall("free_buffer", null, ["number", "number"], [bufPtr, 4 + len]);
      post({ id: id, type: "arrow", ipcBuffer: ipc.buffer, stats: stats() }, [ipc.buffer]);
      return;
    }

    post({ id: id, type: "error", error: "unknown action: " + d.action });
  } catch (err) {
    post({ id: id, type: "error", error: (err && err.message) || String(err) });
  }
};

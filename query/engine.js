/**
 * The browser-side engine bridge: load SedonaDB-WASM in a worker, register files, run SQL.
 *
 * Phase 3 of ASK_THE_DATA_PLAN.md (sections 2 and 3). Everything above this file is pure logic
 * that runs anywhere; everything below it is the labs WASM build. This is the seam.
 *
 * PINNED BUILD. The engine is wherobots/labs-sedona-db-wasm at commit
 *   872041f3e443feb87fada56e0ce9b4603fb0c8c7  (2026-03-11)
 * which is the build the spike was assessed against. The 57.5 MB `sedona_db.wasm` and its glue
 * are NOT committed here (CLAUDE.md rule 5 keeps large binaries out of the repo, and the labs
 * repo has no LICENSE file yet -- see SPIKE_FINDINGS.md blocker B2). `wasmBase` points at wherever
 * they are served from, and loadEngine fails LOUDLY if they are not there: a half-initialised
 * engine that returns empty result sets is the one failure mode this whole feature cannot afford.
 *
 * ⚠️ JSPI IS THE GATING CAPABILITY. The remote-GeoParquet path fetches byte ranges from inside
 * WASM through JavaScript Promise Integration. Without JSPI there is no range read, so there is
 * no query. jspiSupported() is checked BEFORE the 57.5 MB download starts, and the caller is
 * expected to fail visibly rather than fall through to something that looks like an answer.
 *
 * ⚠️ REGISTRATION TAKES AN s3:// URL, NOT AN https:// ONE. register_s3_table parses
 * s3://bucket/key and rebuilds https://<bucket>.s3.<region>.amazonaws.com/<key> internally. Handing
 * it the https URL the app otherwise uses fails inside the engine with a URL-parse error that
 * names neither the bucket nor the file. httpsToS3() does the conversion in one place.
 *
 * ⚠️ REGISTRATION ALSO ISSUES A BUCKET LISTING. The build above calls ListObjectsV2 for schema
 * inference even for a single object, and anonymous LIST is 403 on the public tiles bucket
 * (SPIKE_FINDINGS.md blocker B1). That is why register() surfaces the raw engine error instead of
 * wrapping it: the text is the diagnosis.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.CoRiskQuery = root.CoRiskQuery || {}).engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PINNED_COMMIT = "872041f3e443feb87fada56e0ce9b4603fb0c8c7";

  /** JSPI, as shipped: `WebAssembly.Suspending` plus `WebAssembly.promising`. Feature-detected,
   *  never inferred from a user-agent string. */
  function jspiSupported(scope) {
    var g = scope || (typeof self !== "undefined" ? self : globalThis);
    return !!(g.WebAssembly &&
              typeof g.WebAssembly.Suspending === "function" &&
              typeof g.WebAssembly.promising === "function");
  }

  /** https://<bucket>.s3.<region>.amazonaws.com/<key>  ->  { s3Url, region } */
  function httpsToS3(url) {
    var m = /^https:\/\/([^.]+)\.s3\.([a-z0-9-]+)\.amazonaws\.com\/(.+)$/.exec(url);
    if (!m) throw new Error("not a virtual-hosted S3 URL, cannot register: " + url);
    return { s3Url: "s3://" + m[1] + "/" + m[3], region: m[2] };
  }

  /**
   * Open the engine. Returns a promise for a handle:
   *   { register(url, table), runArrow(sql), stats(), terminate() }
   *
   * `stats()` reports the bytes the worker's fetch shim has counted, which is how the range-read
   * budget in plan section 7 is measured rather than asserted. Counting in the worker is the only
   * place it can be done: the fetches originate inside WASM, not in app code.
   */
  function loadEngine(opts) {
    var o = opts || {};
    if (!jspiSupported()) {
      return Promise.reject(new Error(
        "This browser does not support JSPI, which the engine needs to range-read the extract. " +
        "No query was run. (Chromium-based browsers 2025+; see SPIKE_FINDINGS.md.)"));
    }
    var worker = new Worker(o.workerUrl || "query/spike-worker.js");
    var seq = 0, pending = {};

    worker.onmessage = function (e) {
      var d = e.data || {};
      if (d.type === "debug") { if (o.onDebug) o.onDebug(d.stage); return; }
      var p = pending[d.id];
      if (!p) { if (d.type === "error" && o.onDebug) o.onDebug("engine error: " + d.error); return; }
      delete pending[d.id];
      if (d.type === "error") p.reject(new Error(d.error));
      else p.resolve(d);
    };

    function send(msg, transfer) {
      var id = ++seq;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        msg.id = id;
        worker.postMessage(msg, transfer || []);
      });
    }

    return send({ action: "init", wasmBase: o.wasmBase || "/pkg/" }).then(function () {
      return {
        pinnedCommit: PINNED_COMMIT,
        register: function (url, table) {
          var s = httpsToS3(url);
          return send({ action: "register_s3_table", s3Url: s.s3Url, tableName: table,
                        region: s.region });
        },
        runArrow: function (sql) {
          return send({ action: "execute_sql_arrow", sql: sql });
        },
        stats: function () { return send({ action: "stats" }); },
        terminate: function () { worker.terminate(); }
      };
    });
  }

  return {
    PINNED_COMMIT: PINNED_COMMIT,
    jspiSupported: jspiSupported,
    httpsToS3: httpsToS3,
    loadEngine: loadEngine
  };
});

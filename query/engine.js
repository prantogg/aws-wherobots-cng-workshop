/**
 * The browser engine seam: load CereusDB and run SQL against remote GeoParquet.
 *
 * Replaces the earlier `wherobots/labs-sedona-db-wasm` seam. That build is paused upstream,
 * pending a general `object_store` WASM connector, and it had no licence and no published
 * artifact to pin. CereusDB is a WASM build of the same engine (Apache SedonaDB on DataFusion)
 * that ships on npm under Apache-2.0, so it can be pinned by version and served from a CDN.
 *
 * WHAT WAS MEASURED BEFORE COMMITTING TO IT (all against @cereusdb/standard 0.2.0):
 *   - EPSG:5070 resolves. PROJ is configured at startup and proj.db is embedded, so
 *     ST_Transform works and a 4326 -> 5070 -> 4326 round trip returns the input exactly. The
 *     labs build never called configure_global_proj_engine, which is why this was a risk.
 *   - The `h3_* IN (...)` prefilter really does prune row groups: a 1 km query read 59.5% of a
 *     test file against 98.7% with the predicate removed.
 *   - No JSPI anywhere in the artifact. The transport uses wasm-bindgen's local executor, so
 *     the Chromium-only constraint the plan called its gating risk does not apply.
 *
 * ⚠️ THE `standard` BUILD IS REQUIRED, NOT `minimal`. ST_Transform lives in `standard` and up;
 * `minimal` omits PROJ entirely and every query here would fail on the first transform.
 *
 * ⚠️ THE WASM IS FETCHED AND HASH-CHECKED HERE RATHER THAN LEFT TO THE LOADER. A `<script>` tag
 * can carry a subresource-integrity hash; a dynamic `import()` cannot, and the engine's loader
 * would otherwise fetch 45 MB of executable from a CDN with nothing but the URL vouching for
 * it. So the binary is downloaded, digested, compared against WASM_SHA256, and handed to the
 * engine as bytes. A mismatch refuses to start rather than running it.
 *
 * The small JS glue is still loaded by `import()` and cannot be integrity-checked the same way,
 * which is a residual gap recorded in SPIKE_FINDINGS.md. The version is pinned exactly and
 * jsdelivr serves immutable versioned paths, so the gap is narrow, not absent.
 *
 * ⚠️ REGISTER THE OBJECT STORE AT THE ORIGIN, NEVER AT A PATH PREFIX. Registering it at the
 * file's directory (".../county=08031/") makes the store resolve paths against that prefix, the
 * fetch misses, and the miss enters object_store's retry path. That path calls
 * `std::time::Instant::now()`, which is not implemented on wasm32-unknown-unknown, so it
 * PANICS and takes the whole wasm instance down: "time not implemented on this platform",
 * then RuntimeError: unreachable. Measured, not theorised, and it is upstream
 * arrow-rs-object-store#624.
 *
 * ⚠️ THAT PANIC IS UNRECOVERABLE AND IT IS NOT LIMITED TO BAD REGISTRATION. Any transport error
 * the retry path sees (a 404, a CORS failure, a 403, a dropped connection) can reach the same
 * code. A panicked instance does not throw a catchable error for the NEXT query, it just stays
 * broken. So a file is HEAD-checked before it is registered, which turns the common causes into
 * a clean message, and a failed query marks the engine dead so the following question rebuilds
 * it instead of talking to a corpse.
 *
 * ⚠️ THE ENGINE LOADS ON THE MAIN THREAD, LAZILY, ON THE FIRST DATA QUESTION. That is a
 * deliberate v1 tradeoff: it is roughly 6 MB brotli and compiling it briefly blocks the UI.
 * Putting it in a module Worker is the next step, and the only reason it is not here yet is that
 * it adds a message protocol to something that otherwise has none. Nothing else in the app
 * touches the engine, so moving it later is contained.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.CoRiskQuery = root.CoRiskQuery || {}).engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PACKAGE = "@cereusdb/standard";
  var VERSION = "0.2.0";
  // Pinned exactly. A floating version would change the query engine under a shared link
  // without anything in this repo changing.
  var MODULE_URL = "https://cdn.jsdelivr.net/npm/" + PACKAGE + "@" + VERSION + "/dist/index.js";
  var WASM_URL = "https://cdn.jsdelivr.net/npm/" + PACKAGE + "@" + VERSION +
                 "/dist/wasm/cereusdb_bg.wasm";
  // SHA-256 of that exact binary, cross-checked between the npm tarball and the CDN copy.
  var WASM_SHA256 = "321c382d7acf85c4464777985c09a6997a30c381f8aed0d1b5b8bdae7fdc331b";

  var loading = null;   // the in-flight or settled load, so a second question does not reload

  /**
   * Refuse to run a binary that is not the one this app was built against.
   *
   * Falls back to starting WITHOUT the check only where SubtleCrypto is unavailable, which in
   * practice means a non-secure context (plain http on a non-localhost host). That is announced
   * rather than silent: a quiet downgrade of an integrity check is worse than none, because it
   * looks like the check ran.
   */
  function verifyDigest(buf) {
    var subtle = (typeof crypto !== "undefined") && crypto.subtle;
    if (!subtle) {
      console.warn("[co-risk] engine integrity NOT verified: SubtleCrypto is unavailable " +
                   "(needs a secure context). Serve over https or localhost.");
      return Promise.resolve();
    }
    return subtle.digest("SHA-256", buf).then(function (digest) {
      var hex = Array.prototype.map
        .call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, "0"); })
        .join("");
      if (hex !== WASM_SHA256) {
        throw new Error("the query engine binary does not match the pinned hash and was not " +
                        "run (expected " + WASM_SHA256.slice(0, 12) + "…, got " +
                        hex.slice(0, 12) + "…).");
      }
    });
  }

  /** The origin a store must be registered at. A path prefix is what triggers the panic above. */
  function originOf(url) {
    var u = new URL(url);
    return u.origin + "/";
  }

  /**
   * Load the engine once. Returns a promise for a handle:
   *   { sql(text) -> rows, register(url, table), registered:Set }
   *
   * Registration is per county part file, by concrete URL. The extract's bucket serves
   * GetObject only, and this path needs no bucket listing: the HTTP object store fetches byte
   * ranges from the URL it is given.
   */
  function load(opts) {
    if (loading) return loading;
    var o = opts || {};
    var url = o.moduleUrl || MODULE_URL;
    // `_import` is a test seam. The lifecycle below (idempotent registration, condemning the
    // instance after a wasm trap) is where the subtle failures live, and all of it is reachable
    // without a browser or a 45 MB download if the module load can be stubbed. Production
    // callers pass nothing and get the real dynamic import.
    var load1 = o._import || function (u) { return import(/* webpackIgnore: true */ u); };
    loading = Promise.resolve(load1(url))
      .then(function (mod) {
        if (o.skipIntegrity) return mod.CereusDB.create();
        if (o.onProgress) o.onProgress("downloading the query engine");
        return fetch(o.wasmUrl || WASM_URL).then(function (r) {
          if (!r.ok) throw new Error("engine binary fetch failed (" + r.status + ")");
          return r.arrayBuffer();
        }).then(function (buf) {
          return verifyDigest(buf).then(function () {
            if (o.onProgress) o.onProgress("compiling the query engine");
            return mod.CereusDB.create({ wasmSource: new Uint8Array(buf) });
          });
        });
      })
      .then(function (db) {
        // Keyed by table name, holding the in-flight PROMISE rather than a boolean. A boolean
        // set in .then() is not idempotent for concurrent callers: two counties registering at
        // once both see "not yet registered" and both call through, and the second call races
        // the first inside the engine. The promise is the registration.
        var registered = {};
        var registeredUrl = {};
        var stores = {};
        var handle = {
          version: VERSION,
          raw: db,
          dead: false,
          /** Register one county part file under its own relation name. Idempotent. */
          register: function (fileUrl, table) {
            // A relation name must mean exactly one file for the life of this engine. Relation
            // names are version-scoped upstream so this should be impossible, but if it ever
            // happens the cache would serve the OLD file under the new version's name: wrong
            // rows, right-looking provenance, no error. Fail loudly instead.
            if (registered[table] && registeredUrl[table] !== fileUrl) {
              return Promise.reject(new Error(
                "relation " + table + " is already registered to a different file (" +
                registeredUrl[table] + "); refusing to serve it for " + fileUrl));
            }
            if (registered[table]) return registered[table];
            registeredUrl[table] = fileUrl;
            var origin = originOf(fileUrl);
            // Prove the object is reachable BEFORE handing the URL to the engine, so a missing
            // file or a CORS problem is a message rather than a dead instance.
            registered[table] = fetch(fileUrl, { method: "HEAD" }).then(function (r) {
              if (!r.ok) {
                throw new Error("the extract file could not be read (" + r.status + "): " + fileUrl);
              }
              if (!stores[origin]) {
                db.registerObjectStores({ stores: [{ provider: "http", url: origin }] });
                stores[origin] = true;
              }
              return db.registerParquetTable(table, fileUrl, {});
            }).catch(function (err) {
              // Registration touches the same object-store retry path that can trap, so a
              // failure here has to be able to condemn the instance too. Leaving it marked
              // alive means every later question reuses a dead engine.
              delete registered[table];
              delete registeredUrl[table];
              throw condemn(err);
            });
            return registered[table];
          },
          sql: function (text) {
            return db.sqlJSON(text.replace(/;\s*$/, "")).catch(function (err) {
              throw condemn(err);
            });
          }
        };

        /**
         * A wasm trap leaves the instance unusable for every later call, and it does not
         * announce itself as anything but an opaque RuntimeError. Drop the cached engine so the
         * next question builds a fresh one, and say so rather than surfacing "unreachable".
         */
        function condemn(err) {
          var msg = String((err && err.message) || err);
          if (/unreachable|RuntimeError|not implemented on this platform|unwind/i.test(msg)) {
            handle.dead = true;
            loading = null;
            return new Error("The query engine stopped responding and has been reset. " +
                             "Please ask again.");
          }
          return err instanceof Error ? err : new Error(msg);
        }

        return handle;
      })
      .catch(function (err) {
        loading = null;   // a failed load must not poison every later question
        throw new Error("The query engine could not be loaded (" +
                        (err && err.message ? err.message : err) + ").");
      });
    return loading;
  }

  function isLoaded() { return !!loading; }

  /** Drops the cached load. For tests, and for the condemn path. */
  function _reset() { loading = null; }

  return { PACKAGE: PACKAGE, VERSION: VERSION, MODULE_URL: MODULE_URL, WASM_URL: WASM_URL,
           WASM_SHA256: WASM_SHA256, verifyDigest: verifyDigest,
           load: load, isLoaded: isLoaded, _reset: _reset };
});

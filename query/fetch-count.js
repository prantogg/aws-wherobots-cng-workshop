/**
 * Byte accounting for the engine's fetches, so the range-read budget is MEASURED.
 *
 * Plan section 7 budgets each pruning path at under 25% of the extract size. The requests
 * originate inside WASM, so app-side counting would report zero and read as a spectacular pass.
 * This shim wraps `fetch` in the worker, before the engine glue loads.
 *
 * ⚠️ A MISSING Content-Length MUST NOT COUNT AS ZERO. An earlier version counted only the header
 * and skipped accounting when it was absent, which made an unmeasured response look like a free
 * one and turned the budget into a number that could only improve. A chunked or
 * Content-Length-less response is now counted by READING THE BODY through a counting stream, and
 * if that is impossible the response is recorded as UNMEASURED so the total can be reported as a
 * floor rather than a fact. Both are tracked:
 *
 *   counters.bytes       bytes actually accounted for
 *   counters.unmeasured  responses whose size could not be established (must be 0 for a verdict)
 *
 * Counting the stream rather than cloning avoids buffering a whole row group in memory twice;
 * the engine still reads the body exactly once, through the wrapper.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoRiskFetchCount = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function newCounters() {
    return { requests: 0, bytes: 0, unmeasured: 0, byUrl: {} };
  }

  function add(counters, url, n) {
    counters.bytes += n;
    counters.byUrl[url] = (counters.byUrl[url] || 0) + n;
  }

  /**
   * Wrap a fetch implementation. Returns a fetch with the same signature.
   * `counters` is mutated in place so the worker can report it at any time.
   */
  function countingFetch(realFetch, counters) {
    return function (input, init) {
      var url = String(typeof input === "string" ? input : (input && input.url) || input)
                  .split("?")[0];
      counters.requests++;
      return realFetch(input, init).then(function (res) {
        var len = Number(res.headers.get("content-length"));
        // A ranged response reports the length OF THE RANGE, which is exactly the number the
        // budget is about.
        if (isFinite(len) && len > 0) { add(counters, url, len); return res; }

        // No usable header. Count the body as it is read, and hand back a response carrying the
        // counting stream so the engine still consumes it exactly once.
        if (!res.body || typeof TransformStream === "undefined") {
          counters.unmeasured++;
          return res;
        }
        var counter = new TransformStream({
          transform: function (chunk, controller) {
            add(counters, url, chunk.byteLength || chunk.length || 0);
            controller.enqueue(chunk);
          }
        });
        return new Response(res.body.pipeThrough(counter), {
          status: res.status, statusText: res.statusText, headers: res.headers
        });
      });
    };
  }

  /** A measurement is only quotable when nothing went uncounted. */
  function isMeasurementSound(counters) { return counters.unmeasured === 0; }

  return {
    newCounters: newCounters,
    countingFetch: countingFetch,
    isMeasurementSound: isMeasurementSound
  };
});

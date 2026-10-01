/**
 * The canonical validator for every "ask the data" query, from any origin.
 *
 * Phase 3 of ASK_THE_DATA_PLAN.md (sections 5 and 6). ONE implementation, deliberately: the
 * plan requires an agent tool call and a hand-edited `?q=` deep link to pass through the same
 * allowlist and clamps. Two copies would drift, and the copy that drifts is the one an attacker
 * or a pasted link uses.
 *
 * REJECT-OR-CLAMP IS DECIDED BY WHICH END, and only the upper end is clamped:
 *   radius_m : reject non-numeric / NaN / Infinity / zero / negative;  clamp  > 80000 -> 80000
 *   limit    : reject non-integer / NaN / Infinity / zero / negative;  clamp  > 50    -> 50
 *   metric   : allowlist, reject anything else (never interpolated into SQL as a free string)
 *   center   : finite lon in [-180,180] and lat in [-90,90], else reject
 *   version  : /^\d{8}$/, else reject (existence is checked separately, over the network)
 * There is no lower bound to clamp toward. A zero radius is a mistake, not a small query, and
 * silently turning it into a default hides the mistake from whoever wrote the link.
 *
 * WHY THE ALLOWLIST IS THE PARAMETERIZATION. SQL has no bind syntax for an identifier, so a
 * metric cannot be passed as a parameter the way a number can. The allowlist IS the binding:
 * the model and the URL choose a KEY, and this file owns the mapping from key to column name.
 * Raw model output never reaches an ORDER BY or a column slot.
 *
 * Clamps are RECORDED, not silent (`result.clamps`), so the UI and the copilot summary can say
 * "clamped to 80 km" instead of quietly answering a different question than the one asked.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.CoRiskQuery = root.CoRiskQuery || {}).validate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // key -> column. Identity today, and still written out: the key is a public API (it appears
  // in shared links and in the model's tool schema) while the column is an extract detail.
  var METRIC_COLUMNS = {
    insurance: "ins_score",
    cre: "cre_score",
    capital_markets: "cap_score",
    energy: "en_score",
    wildfire: "wildfire_factor",
    flood: "flood_factor",
    severe_weather: "severe_weather_factor",
    outage_probability: "outage_probability"
  };

  var MAX_RADIUS_M = 80000;   // keeps partition pruning effective (plan section 5)
  var MAX_LIMIT = 50;         // keeps the result layer sane on a phone-class browser

  /** Number() over a string rejects trailing garbage ("39.6oops" -> NaN), which parseFloat
   *  accepts. Booleans, arrays, objects and null all coerce to numbers in JS, so the type is
   *  checked before the coercion rather than after it. */
  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return NaN;
  }

  function validateRadius(v) {
    var n = num(v);
    if (!isFinite(n) || n <= 0) {
      return { ok: false, error: "radius_m must be a finite number greater than 0" };
    }
    if (n > MAX_RADIUS_M) {
      return { ok: true, value: MAX_RADIUS_M,
               clamp: "radius_m clamped from " + n + " m to " + MAX_RADIUS_M + " m" };
    }
    return { ok: true, value: n };
  }

  function validateLimit(v) {
    var n = num(v);
    if (!isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "limit must be a whole number greater than 0" };
    }
    if (n > MAX_LIMIT) {
      return { ok: true, value: MAX_LIMIT,
               clamp: "limit clamped from " + n + " to " + MAX_LIMIT };
    }
    return { ok: true, value: n };
  }

  function validateMetric(v) {
    if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(METRIC_COLUMNS, v)) {
      return { ok: false,
               error: "metric must be one of: " + Object.keys(METRIC_COLUMNS).join(", ") };
    }
    return { ok: true, value: v, column: METRIC_COLUMNS[v] };
  }

  /** Runs on EVERY invocation, including a geocoded centre. A geocoder that returns garbage is
   *  exactly as dangerous as a hand-edited link, and the model calling query_properties directly
   *  gets no exemption. */
  function validateCenter(c) {
    if (!c || typeof c !== "object") return { ok: false, error: "center is required" };
    var lon = num(c.lon), lat = num(c.lat);
    if (!isFinite(lon) || !isFinite(lat)) {
      return { ok: false, error: "center lon/lat must be finite numbers" };
    }
    if (lon < -180 || lon > 180) return { ok: false, error: "center lon out of range [-180, 180]" };
    if (lat < -90 || lat > 90) return { ok: false, error: "center lat out of range [-90, 90]" };
    return { ok: true, value: { lon: lon, lat: lat } };
  }

  /** Format only. Existence is a network check against the version's manifest.json (section 6),
   *  which this synchronous validator deliberately does not do. */
  function validateVersion(v) {
    if (v === undefined || v === null || v === "") return { ok: true, value: null };
    if (typeof v !== "string" || !/^\d{8}$/.test(v)) {
      return { ok: false, error: "version must be 8 digits (YYYYMMDD)" };
    }
    return { ok: true, value: v };
  }

  /**
   * The one entry point. Returns
   *   { ok: true,  value: {center, radius_m, metric, metricColumn, limit, version}, clamps: [] }
   *   { ok: false, errors: ["..."] }
   * Every field is validated on every call; there is no partial-credit path where some fields
   * are checked and others are trusted because of where they came from.
   */
  function validateQuery(input) {
    var errors = [], clamps = [], out = {};
    var i = input || {};

    var checks = [
      ["center", validateCenter(i.center)],
      ["radius_m", validateRadius(i.radius_m)],
      ["metric", validateMetric(i.metric)],
      ["limit", validateLimit(i.limit)],
      ["version", validateVersion(i.version)]
    ];
    for (var k = 0; k < checks.length; k++) {
      var field = checks[k][0], r = checks[k][1];
      if (!r.ok) { errors.push(r.error); continue; }
      out[field] = r.value;
      if (r.clamp) clamps.push(r.clamp);
      if (field === "metric") out.metricColumn = r.column;
    }
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, value: out, clamps: clamps };
  }

  /**
   * Parse a `?q=` deep link into the same shape, then validate it. The URL is an INPUT to the
   * query tool, never a shortcut around it, so nothing here is trusted: the parse only splits
   * strings, and every value still goes through validateQuery.
   *
   * Recognised params: lon, lat, radius_m, metric, limit, version. A link carrying only
   * lat/lon/zoom stays the existing viewport-only deep link and is not a query link
   * (`isQueryLink` is false), so the app must not invent a query for it.
   */
  function parseQueryLink(search) {
    var p = new URLSearchParams(search || "");
    if (!p.has("q")) return { isQueryLink: false };
    var q = new URLSearchParams(p.get("q"));
    return {
      isQueryLink: true,
      result: validateQuery({
        center: { lon: q.get("lon"), lat: q.get("lat") },
        radius_m: q.get("radius_m"),
        metric: q.get("metric"),
        limit: q.get("limit"),
        version: q.get("version")
      })
    };
  }

  /** The inverse, for the share button. Built from a VALIDATED value, so a link this app emits
   *  always survives its own parser. */
  function buildQueryLink(value) {
    var q = new URLSearchParams();
    q.set("lon", String(value.center.lon));
    q.set("lat", String(value.center.lat));
    q.set("radius_m", String(value.radius_m));
    q.set("metric", value.metric);
    q.set("limit", String(value.limit));
    if (value.version) q.set("version", value.version);
    return "?q=" + encodeURIComponent(q.toString());
  }

  return {
    METRIC_COLUMNS: METRIC_COLUMNS,
    MAX_RADIUS_M: MAX_RADIUS_M,
    MAX_LIMIT: MAX_LIMIT,
    validateRadius: validateRadius,
    validateLimit: validateLimit,
    validateMetric: validateMetric,
    validateCenter: validateCenter,
    validateVersion: validateVersion,
    validateQuery: validateQuery,
    parseQueryLink: parseQueryLink,
    buildQueryLink: buildQueryLink
  };
});

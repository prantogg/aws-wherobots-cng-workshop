/**
 * The file-to-relation bridge: which county part files a query touches, and what to call them.
 *
 * Phase 3 of ASK_THE_DATA_PLAN.md (sections 3, 4 and 6). The extract is a DIRECTORY of per-county
 * part files, but the SQL is written against one relation named `co_risk_query`. This module
 * selects which files are in play; sqlbuild.js turns them into that relation. Nothing is required
 * of the engine beyond `register_s3_table`: NO DDL, no CREATE VIEW, no directory glob.
 *
 * WHY THE BROWSER PICKS THE FILES INSTEAD OF LETTING THE ENGINE PRUNE A DIRECTORY. Two reasons,
 * and the second one is decisive:
 *   1. Explicit per-file selection bounds the read whether or not the engine prunes by directory,
 *      so the "reads a handful of counties, never the state" claim does not rest on an engine
 *      behaviour nobody measured.
 *   2. Registering a directory needs a bucket LISTING, and anonymous ListObjectsV2 is 403 on the
 *      public tiles bucket by design (see "A retraction" in SPIKE_FINDINGS.md). A per-file URL is the
 *      only registration shape that can work there at all.
 *
 * THE COUNTY SELECTION IS A SUPERSET, THE SAME WAY THE H3 SET IS. It is every county whose extent
 * INTERSECTS the query circle, not the county containing the centre. A 40 km query centred three
 * kilometres from a county line reaches well into the neighbour, and selecting one county would
 * drop those buildings with nothing to show for it. The circle is converted to a degree box
 * conservatively (widest longitude degree over the latitude span, not at the centre latitude), so
 * the box is never narrower than the circle.
 *
 * ⚠️ bbox IN THE MANIFEST IS WGS84 WHILE THE GEOMETRY COLUMN IS EPSG:5070. That is deliberate:
 * files are chosen BEFORE any engine call, so nothing has been transformed yet and the only
 * coordinates in hand are the lon/lat the user typed.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.CoRiskQuery = root.CoRiskQuery || {}).registry = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_BASE = "https://co-pc-risk-tiles-benp-uw2.s3.us-west-2.amazonaws.com/tiles/query/";
  var TABLE_PREFIX = "co_risk_query_";

  /**
   * The engine-side relation name for one county file.
   *
   * ⚠️ THE VERSION IS PART OF THE NAME, AND THAT IS THE POINT. The engine caches a registration
   * by relation name. Naming it after the county alone means that when a new extract is
   * published mid-session, or a shared link pins a different version, the same name already
   * maps to the PREVIOUS version's file: the cache hits, the old file is queried, and the
   * result is reported under the new version id. Wrong rows, right-looking provenance, no
   * error. Including the version makes a different version a different relation, so a stale
   * registration cannot be reused by accident.
   */
  function tableName(version, fips) { return TABLE_PREFIX + "v" + version + "_" + fips; }
  // WGS84, the datum the manifest bboxes and the query centre are in.
  var A = 6378137.0, E2 = 0.00669437999014;
  // Residual margin on top of the curvature maths: proportional, plus an absolute floor so a
  // small radius still gets a real margin (0.1% of 500 m is half a metre, which is too thin to
  // call a guarantee). A box wider by 25 m can only ever select one extra county file, which
  // the exact distance test then filters out.
  var BOX_SAFETY = 1.001;
  var BOX_FLOOR_M = 25;

  /** Meridional radius of curvature: governs how far a metre moves you in LATITUDE. */
  function meridionalRadius(latDeg) {
    var s = Math.sin(latDeg * Math.PI / 180);
    return A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5);
  }

  /** Prime-vertical radius: with cos(lat), governs how far a metre moves you in LONGITUDE. */
  function primeVerticalRadius(latDeg) {
    var s = Math.sin(latDeg * Math.PI / 180);
    return A / Math.sqrt(1 - E2 * s * s);
  }

  /**
   * Degree box containing the query circle, from WGS84 RADII OF CURVATURE.
   *
   * ⚠️ A SPHERE IS NOT CLOSE ENOUGH HERE, AND IT FAILS SHORT. An earlier version walked
   * great-circle cardinal points with the mean Earth radius (6,371,009 m). The meridional
   * radius at Colorado's latitudes is about 6,360,700 m, roughly 0.16% SMALLER, and because the
   * angular step is `distance / radius`, using the larger mean radius understates it. Measured
   * against Vincenty: the box edge landed up to **81 m inside** the true circle at the 80 km
   * clamp in southern Colorado, against a 0.1% pad worth only 80 m.
   *
   * That is the unsafe direction. This runs BEFORE any distance test and permanently decides
   * which county files are registered, so a county whose extent intersects only that short
   * strip is never registered and its in-radius buildings cannot be recovered downstream: the
   * silent undercount the floors guardrail exists to prevent.
   *
   * Both extents are evaluated where the local radius is SMALLEST over the span the circle
   * covers, which is what makes the box a superset rather than an approximation:
   *   - latitude: the meridional radius grows with latitude, so the equator-ward edge governs;
   *   - longitude: a degree shrinks with latitude, so the pole-ward edge governs.
   */
  function circleBox(center, radiusM) {
    var r = radiusM * BOX_SAFETY + BOX_FLOOR_M;
    var deg = 180 / Math.PI;

    // A first bound on the latitude span, using the smallest meridional radius anywhere (at the
    // equator), then re-evaluated at the equator-ward end of that span.
    var coarse = (r / meridionalRadius(0)) * deg;
    var equatorward = Math.max(0, Math.abs(center.lat) - coarse);
    var dLat = (r / meridionalRadius(equatorward)) * deg;

    var north = center.lat + dLat, south = center.lat - dLat;
    var poleward = Math.min(89.9, Math.max(Math.abs(north), Math.abs(south)));
    var dLon = (r / (primeVerticalRadius(poleward) * Math.cos(poleward * Math.PI / 180))) * deg;

    return [center.lon - dLon, south, center.lon + dLon, north];
  }

  function versionRoot(version, base) { return (base || DEFAULT_BASE) + "co_risk_query.v" + version + "/"; }
  function manifestUrl(version, base) { return versionRoot(version, base) + "manifest.json"; }
  function latestUrl(base) { return (base || DEFAULT_BASE) + "co_risk_query.latest.json"; }

  function boxesIntersect(a, b) {
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
  }

  /**
   * The counties whose extent the circle touches, as registration descriptors:
   *   { county, name, rows, url, table }
   * `table` is the per-file relation name the engine registers; sqlbuild.js UNIONs them into
   * `co_risk_query`. An empty result is returned as-is, NOT as the whole state: a query centred
   * outside Colorado has no data, and answering it with every county would be a slow way of
   * returning nothing.
   */
  function selectCounties(manifest, center, radiusM, base) {
    var box = circleBox(center, radiusM);
    var root = versionRoot(manifest.version, base);
    return (manifest.counties || [])
      .filter(function (c) { return boxesIntersect(box, c.bbox); })
      .map(function (c) {
        return {
          county: c.county,
          name: c.name,
          rows: c.rows,
          url: root + c.path,
          table: tableName(manifest.version, c.county)
        };
      });
  }

  /**
   * Resolve which extract version a query runs against, honouring a pinned version from a shared
   * link. `head(url)` is injected (the caller passes a fetch-backed HEAD) so this stays testable
   * without a network.
   *
   * A PINNED VERSION THAT NO LONGER EXISTS DOES NOT SILENTLY BECOME `latest`. That would break the
   * one promise a versioned link makes, and the recipient would have no way to know the numbers
   * they are reading are not the numbers that were shared. It falls back, and it says so, and the
   * notice is part of the return value rather than a console line.
   *
   * The existence check HEADs manifest.json, a concrete object: S3 has no directory to HEAD, and
   * HEADing one county part file would prove only that county survived retention.
   */
  function resolveVersion(pinned, latestVersion, head, base) {
    if (!pinned || pinned === latestVersion) {
      return Promise.resolve({ version: latestVersion, pinned: false, notice: null });
    }
    return Promise.resolve(head(manifestUrl(pinned, base))).then(function (exists) {
      if (exists) return { version: pinned, pinned: true, notice: null };
      return {
        version: latestVersion,
        pinned: false,
        notice: "This shared result used data version " + pinned + ", which is no longer " +
                "retained; showing the latest version (" + latestVersion + ") instead. The rows " +
                "below may differ from the ones that were shared."
      };
    });
  }

  return {
    DEFAULT_BASE: DEFAULT_BASE,
    TABLE_PREFIX: TABLE_PREFIX,
    tableName: tableName,
    versionRoot: versionRoot,
    manifestUrl: manifestUrl,
    latestUrl: latestUrl,
    circleBox: circleBox,
    BOX_SAFETY: BOX_SAFETY,
    BOX_FLOOR_M: BOX_FLOOR_M,
    meridionalRadius: meridionalRadius,
    primeVerticalRadius: primeVerticalRadius,
    boxesIntersect: boxesIntersect,
    selectCounties: selectCounties,
    resolveVersion: resolveVersion
  };
});

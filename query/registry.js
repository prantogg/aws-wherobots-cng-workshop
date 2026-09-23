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
 *      public tiles bucket by design (see SPIKE_FINDINGS.md blocker B1). A per-file URL is the
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
  var EARTH_R = 6371008.8;    // metres, mean Earth radius
  var BOX_SAFETY = 1.001;     // see circleBox

  function versionRoot(version, base) { return (base || DEFAULT_BASE) + "co_risk_query.v" + version + "/"; }
  function manifestUrl(version, base) { return versionRoot(version, base) + "manifest.json"; }
  function latestUrl(base) { return (base || DEFAULT_BASE) + "co_risk_query.latest.json"; }

  /** Destination point at `d` metres along `bearing` from (lat, lng), on a sphere. */
  function destination(lat, lng, d, bearing) {
    var dr = d / EARTH_R, br = bearing * Math.PI / 180;
    var la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(br));
    var lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la),
                              Math.cos(dr) - Math.sin(la) * Math.sin(la2));
    return [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI) + 540) % 360 - 180];
  }

  /**
   * Degree box containing the query circle, from GEODESIC cardinal points rather than a
   * metres-per-degree constant.
   *
   * ⚠️ A CONSTANT IS THE WRONG TOOL HERE, AND IT FAILED IN THE UNSAFE DIRECTION. An earlier
   * version divided by a flat 111,320 m per degree of latitude. Colorado's true meridional figure
   * near 39 degrees is about 111,000, so the box came out SHORT, by a couple of hundred metres at
   * the 80 km clamp. This function runs BEFORE any distance test and permanently decides which
   * county files are registered, so a county whose rows sit in that sliver is dropped with no
   * error anywhere: the silent undercount the floors guardrail exists to prevent, not a rounding
   * detail.
   *
   * The east and west edges are taken at the box's own highest-latitude edge, not at the centre,
   * because a degree of longitude shrinks with latitude and the widest span is at the far edge.
   * BOX_SAFETY pads everything by 0.1%, covering the gap between this spherical model and the
   * ellipsoid the data sits on (the WGS84 meridian radius varies by about 0.5% equator to pole).
   * The pad can only ever select an extra file, which the exact ST_DWithin then filters out.
   */
  function circleBox(center, radiusM) {
    var r = radiusM * BOX_SAFETY;
    var north = destination(center.lat, center.lon, r, 0)[0];
    var south = destination(center.lat, center.lon, r, 180)[0];
    var widestLat = Math.abs(north) > Math.abs(south) ? north : south;
    var east = destination(widestLat, center.lon, r, 90)[1];
    var west = destination(widestLat, center.lon, r, 270)[1];
    return [Math.min(west, east), Math.min(south, north),
            Math.max(west, east), Math.max(south, north)];
  }

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
          table: TABLE_PREFIX + c.county
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
    destination: destination,
    versionRoot: versionRoot,
    manifestUrl: manifestUrl,
    latestUrl: latestUrl,
    circleBox: circleBox,
    boxesIntersect: boxesIntersect,
    selectCounties: selectCounties,
    resolveVersion: resolveVersion
  };
});

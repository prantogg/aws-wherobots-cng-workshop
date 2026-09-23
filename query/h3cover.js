/**
 * The partition prefilter: which H3 resolution to prune at, and which cells cover the circle.
 *
 * Phase 3 of ASK_THE_DATA_PLAN.md (section 3). ST_DWithin is not a Parquet statistics filter,
 * so without this the engine reads geometry from every row group and the "pruning" in the plan
 * is a no-op nothing reports. This file emits a literal `h3_<res> IN (...)` predicate the reader
 * prunes on BEFORE any distance math.
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING, AND THEY PULL AGAINST EACH OTHER:
 *
 *   1. THE CELL SET IS A CONSERVATIVE SUPERSET. It must contain every cell the circle TOUCHES,
 *      not every cell whose centroid is inside it. h3.polygonToCells is a centroid-containment
 *      polyfill: a cell straddling the circle's edge, with its centroid just outside, holds
 *      buildings just INSIDE the radius, and a centroid polyfill drops them silently -- a wrong
 *      answer with no error anywhere. So the polyfill runs against the circle BUFFERED OUTWARD
 *      (see BUFFER_EDGES below), and the exact ST_DWithin afterwards removes the extra cells'
 *      non-matching rows. The superset costs a little scan; a centroid polyfill costs
 *      correctness.
 *
 *   2. THE CELL COUNT STAYS BOUNDED. A fixed res-7 explodes with radius (a ~5.16 km2 cell needs
 *      thousands of cells to cover the 80 km clamp), and an IN list of thousands of literals is
 *      its own problem. So the selector takes the FINEST resolution whose covering set fits
 *      under MAX_CELLS, which keeps the predicate both bounded and TIGHT -- finest-under-cap is
 *      what stops a 1 km question from dragging in a res-5 partition.
 *
 * WHEN NO RESOLUTION FITS, THERE IS NO H3 PREDICATE. The extract stores only res 5, 6 and 7, so
 * past roughly the 80 km clamp even res-5 exceeds the cap. That is not a failure: the caller
 * falls back to selecting whole county part files (registry.js), which is a superset too. This
 * module reports that case explicitly (`mode: "county"`) instead of returning a huge list.
 *
 * ⚠️ CELL IDS ARE EMITTED AS DECIMAL, NOT HEX. The extract's h3_5/h3_6/h3_7 columns come from
 * Sedona's ST_H3CellIDs, which returns a BIGINT. h3-js returns the same value as a hex string.
 * Comparing '86268cdafffffff' against a bigint column matches nothing and raises nothing useful,
 * so the hex is converted through BigInt here, once.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./h3-node.js"));
  } else {
    (root.CoRiskQuery = root.CoRiskQuery || {}).h3cover = factory(root.h3);
  }
})(typeof self !== "undefined" ? self : this, function (h3) {
  "use strict";

  // The pinned h3-js build, declared HERE and nowhere else: the browser script tag, the test
  // fetch script and h3-node.js all read it from this file, so there is one version and one
  // integrity hash to change. Integrity is checked on download because this is a CDN dependency
  // that ends up deciding which buildings a query returns.
  var H3_JS_VERSION = "4.1.0";
  var H3_JS_URL = "https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js";
  var H3_JS_SHA256 = "0870d94de38503bdf6b63dce8c4812a42dc43565f15ae35694aedf4f97eaf548";

  var RESOLUTIONS = [7, 6, 5];   // finest first; these are the three the extract stores
  var MAX_CELLS = 64;            // plan section 7's cell-count bound

  /**
   * How far outward to buffer the circle before the centroid polyfill, in units of the
   * resolution's average edge length.
   *
   * A cell's centroid is at most its circumradius (one edge length, for a regular hexagon) from
   * any point in it. So buffering by one edge already makes centroid-containment a superset of
   * touch-containment. H3 cells are not perfectly regular and edge length varies within a
   * resolution, so this carries a safety factor rather than sitting exactly on the bound. The
   * cost of the extra ring is scan the ST_DWithin removes; the cost of being one cell short is
   * a missing building.
   */
  var BUFFER_EDGES = 2.0;

  var EARTH_R = 6371008.8;       // metres, mean Earth radius

  /** Destination point at `d` metres along `bearing` from (lat, lng). Great-circle, because a
   *  flat-earth offset is visibly wrong at the 80 km clamp. */
  function destination(lat, lng, d, bearing) {
    var dr = d / EARTH_R, br = bearing * Math.PI / 180;
    var la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(br));
    var lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la),
                              Math.cos(dr) - Math.sin(la) * Math.sin(la2));
    return [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI) + 540) % 360 - 180];
  }

  /** Closed [lat, lng] ring approximating a circle. 180 vertices keeps the inscribed polygon
   *  within ~0.02% of the true circle, far inside the buffer above. */
  function circleRing(lat, lng, radiusM, steps) {
    var n = steps || 180, ring = [];
    for (var i = 0; i < n; i++) ring.push(destination(lat, lng, radiusM, (360 / n) * i));
    ring.push(ring[0]);
    return ring;
  }

  /** Every cell the circle touches, at one resolution. Always includes the centre cell, which
   *  matters for a radius smaller than a single cell. */
  function cellsForResolution(center, radiusM, res) {
    var buffered = radiusM + BUFFER_EDGES * h3.getHexagonEdgeLengthAvg(res, "m");
    var cells = h3.polygonToCells([circleRing(center.lat, center.lon, buffered)], res, false);
    var centre = h3.latLngToCell(center.lat, center.lon, res);
    if (cells.indexOf(centre) === -1) cells.push(centre);
    return cells;
  }

  function toDecimal(cell) { return BigInt("0x" + cell).toString(); }

  /**
   * Pick the resolution and build the predicate inputs.
   *
   * Returns either
   *   { mode: "h3",     resolution, column: "h3_6", cells: [hex...], cellIds: ["decimal"...],
   *     cellCount, tried: [{res, cells}...] }
   * or
   *   { mode: "county", reason, tried: [...] }
   *
   * `tried` is kept so the spike harness and any future regression can SHOW that res-7 was
   * considered and rejected at a large radius, rather than asserting it was.
   */
  function coverCircle(center, radiusM, opts) {
    var maxCells = (opts && opts.maxCells) || MAX_CELLS;
    var tried = [];
    for (var i = 0; i < RESOLUTIONS.length; i++) {
      var res = RESOLUTIONS[i];
      var cells = cellsForResolution(center, radiusM, res);
      tried.push({ resolution: res, cells: cells.length });
      if (cells.length <= maxCells) {
        return {
          mode: "h3",
          resolution: res,
          column: "h3_" + res,
          cells: cells,
          cellIds: cells.map(toDecimal),
          cellCount: cells.length,
          tried: tried
        };
      }
    }
    return {
      mode: "county",
      reason: "no stored H3 resolution covers " + Math.round(radiusM) + " m in " + maxCells +
              " cells or fewer (tried " +
              tried.map(function (t) { return "res-" + t.resolution + ": " + t.cells; }).join(", ") +
              "); falling back to whole-county part files",
      tried: tried
    };
  }

  return {
    H3_JS_VERSION: H3_JS_VERSION,
    H3_JS_URL: H3_JS_URL,
    H3_JS_SHA256: H3_JS_SHA256,
    RESOLUTIONS: RESOLUTIONS,
    MAX_CELLS: MAX_CELLS,
    BUFFER_EDGES: BUFFER_EDGES,
    destination: destination,
    circleRing: circleRing,
    cellsForResolution: cellsForResolution,
    coverCircle: coverCircle
  };
});

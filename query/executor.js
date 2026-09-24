/**
 * The browser-side executor: everything between the model's typed arguments and a row list.
 *
 * The model never emits SQL. It fills arguments; this file validates them, decides the prune,
 * selects the county files, builds the statement, runs it, and returns rows with provenance.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE:
 *   validate -> resolve version -> select county files -> cover -> build SQL -> register -> run
 * Validation is first because everything after it interpolates values into a URL or a
 * statement. A deep link and an agent tool call enter at exactly the same point.
 *
 * ⚠️ THE EXACT RADIUS IS APPLIED HERE, NOT IN SQL. The SQL predicate runs in EPSG:5070, which
 * is equal-area and therefore distorts distance by about +0.8% north-south and -0.7% east-west
 * across Colorado. sqlbuild inflates the predicate past that so it never drops a building that
 * is genuinely inside the radius, and over-fetches; this file then measures each returned point
 * geodesically from the query centre and applies `radius_m` exactly. The number the user sees
 * is a true ground distance, not a projected one.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./validate.js"), require("./h3cover.js"),
                             require("./registry.js"), require("./sqlbuild.js"),
                             require("./gazetteer.js"));
  } else {
    var Q = (root.CoRiskQuery = root.CoRiskQuery || {});
    Q.executor = factory(Q.validate, Q.h3cover, Q.registry, Q.sqlbuild, Q.gazetteer);
  }
})(typeof self !== "undefined" ? self : this, function (validate, h3cover, registry, sqlbuild,
                                                       gazetteer) {
  "use strict";

  // WGS84, the datum the returned lon/lat are in.
  var WGS84_A = 6378137.0;            // semi-major axis, metres
  var WGS84_F = 1 / 298.257223563;    // flattening
  var WGS84_B = WGS84_A * (1 - WGS84_F);

  /**
   * Distance on the WGS84 ELLIPSOID (Vincenty inverse), in metres.
   *
   * ⚠️ A SPHERE IS NOT GOOD ENOUGH HERE, AND THAT IS THE WHOLE POINT OF THIS FUNCTION. It exists
   * to correct the equal-area projection's distance error, which is about 0.8% across Colorado.
   * Haversine on a mean-radius sphere carries its own error of the same order (the ellipsoid's
   * radius of curvature at latitude 40 differs from the mean radius by roughly half a percent,
   * and it differs by direction), so measuring the correction with a sphere would swap one
   * approximation for another and still call the result a ground distance.
   *
   * Vincenty converges in a handful of iterations at these distances. It fails to converge only
   * for near-antipodal points, which cannot arise inside an 80 km radius; if it ever does, this
   * falls back to the spherical value rather than returning NaN into a distance filter.
   */
  function geodesic(aLat, aLon, bLat, bLon) {
    var rad = Math.PI / 180;
    var L = (bLon - aLon) * rad;
    var U1 = Math.atan((1 - WGS84_F) * Math.tan(aLat * rad));
    var U2 = Math.atan((1 - WGS84_F) * Math.tan(bLat * rad));
    var sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    var sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
    var lambda = L, prev, iter = 0;
    var sinSigma, cosSigma, sigma, sinAlpha, cos2Alpha, cos2SigmaM, C;
    do {
      var sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
      sinSigma = Math.sqrt((cosU2 * sinLambda) * (cosU2 * sinLambda) +
                           (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) *
                           (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda));
      if (sinSigma === 0) return 0;                 // coincident points
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
      sigma = Math.atan2(sinSigma, cosSigma);
      sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
      cos2Alpha = 1 - sinAlpha * sinAlpha;
      cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - 2 * sinU1 * sinU2 / cos2Alpha;  // equatorial
      C = WGS84_F / 16 * cos2Alpha * (4 + WGS84_F * (4 - 3 * cos2Alpha));
      prev = lambda;
      lambda = L + (1 - C) * WGS84_F * sinAlpha *
               (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma *
                (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    } while (Math.abs(lambda - prev) > 1e-12 && ++iter < 100);

    if (iter >= 100) return sphericalFallback(aLat, aLon, bLat, bLon);

    var uSq = cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
    var A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    var B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    var dSigma = B * sinSigma * (cos2SigmaM + B / 4 *
      (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
       B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
       (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    return WGS84_B * A * (sigma - dSigma);
  }

  /** Only reached if Vincenty does not converge, which needs near-antipodal points. */
  function sphericalFallback(aLat, aLon, bLat, bLon) {
    var t = Math.PI / 180;
    var dLat = (bLat - aLat) * t, dLon = (bLon - aLon) * t;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * FALLBACK disclosure, for an extract whose manifest predates the `disclosure` field. The
   * pipeline writes the authoritative copy into manifest.json next to the numbers it describes,
   * and `run()` prefers that; two independently worded copies would drift, and the one that
   * drifts is the one shipped next to the data.
   *
   * Either way it is restated per query rather than left to the system prompt, because the
   * prompt is one turn away from being summarised into "top 10 riskiest properties", which is
   * not what these numbers are (CLAUDE.md rules 1, 2, 3, 4).
   */
  var DISCLOSURE = {
    grain: "Scored buildings from Overture, not parcels. Hazard is sampled at the building " +
           "centroid.",
    composite: "composite is a SCREENING SUM of five narrow scores (domain 0-7), not a loss " +
               "estimate and not a determination of insurability.",
    modeled: "wf/hail/flood/wind scores are MODELED or INHERITED from coarser resolution " +
             "(USFS model output, FEMA NRI tract resolution, regulatory designation), not " +
             "measured at the structure.",
    access: "access_score is a 0/1 COHORT FLAG (1 = beyond the access boundary, including " +
            "buildings with no fire station within 25 km). It is not a measurement.",
    floors: "The building spine is a FLOOR, not a census.",
    dollars: "No property value is in this dataset, so nothing here can be ranked by dollars."
  };

  /**
   * The single constructor for a successful result. Every branch goes through it, so the shape
   * cannot drift between "found rows", "found nothing" and "outside the data".
   */
  function result(ctx, value, rows, counties, prune, notices, empty) {
    return {
      ok: true,
      rows: rows,
      version: ctx.manifest.version,
      center: value.center,
      radius_m: value.radius_m,
      metric: value.metric,
      limit: value.limit,
      counties: counties.map(function (c) { return c.name; }),
      prune: prune,
      notices: notices,
      empty: empty || null,
      // The extract ships its own disclosure in manifest.json, written by the pipeline that
      // produced the numbers. Prefer it, so the wording cannot drift from the data.
      disclosure: (ctx.manifest && ctx.manifest.disclosure) || DISCLOSURE,
      link: validate.buildQueryLink({
        center: value.center, radius_m: value.radius_m, metric: value.metric,
        limit: value.limit, version: ctx.manifest.version })
    };
  }

  function makeManifestLoader(fetchImpl, base) {
    var f = fetchImpl || (typeof fetch === "function" ? fetch.bind(null) : null);
    return {
      latest: function () {
        return f(registry.latestUrl(base), { cache: "no-store" }).then(function (r) {
          if (!r.ok) throw new Error("no published extract (latest pointer returned " + r.status + ")");
          return r.json();
        });
      },
      manifest: function (version) {
        return f(registry.manifestUrl(version, base)).then(function (r) {
          if (!r.ok) throw new Error("extract version " + version + " is not readable (" + r.status + ")");
          return r.json();
        });
      },
      head: function (url) {
        return f(url, { method: "HEAD" }).then(function (r) { return r.ok; },
                                              function () { return false; });
      }
    };
  }

  /**
   * Run one query. `deps` carries the engine handle and (for tests) a fetch implementation.
   * Resolves to a result object; REJECTS only on a programming error. Everything a user or a
   * link can get wrong comes back as `{ ok:false, errors }` so the copilot can say what was
   * wrong rather than showing a stack trace.
   */
  function run(input, deps) {
    var d = deps || {};
    var base = d.base;
    var io = d.io || makeManifestLoader(d.fetch, base);

    var v = validate.validateQuery(input);
    if (!v.ok) return Promise.resolve({ ok: false, errors: v.errors });
    var value = v.value, notices = v.clamps.slice();

    return io.latest().then(function (latest) {
      return registry.resolveVersion(value.version, latest.version, io.head, base);
    }).then(function (resolved) {
      if (resolved.notice) notices.push(resolved.notice);
      return io.manifest(resolved.version).then(function (manifest) {
        return { resolved: resolved, manifest: manifest };
      });
    }).then(function (ctx) {
      var manifest = ctx.manifest;
      var counties = registry.selectCounties(manifest, value.center, value.radius_m, base);
      if (!counties.length) {
        // ⚠️ SAME SHAPE AS A SUCCESSFUL RESULT, INCLUDING center/radius_m/metric/limit/link.
        // An earlier version omitted them, and the renderer reads `res.center.lat` and
        // `res.radius_m` unconditionally: a ?q= link pointing outside Colorado threw a
        // TypeError and the page rendered nothing at all, which is a worse answer than "there
        // is no data there".
        return result(ctx, value, [], counties, null, notices,
                      "That point is outside the Colorado data in this map, so there is " +
                      "nothing to rank.");
      }
      var cover = h3cover.coverCircle(value.center, value.radius_m);
      var built = sqlbuild.buildQuery(value, cover, counties);

      if (!d.engine) throw new Error("no engine handle supplied to the executor");
      return Promise.all(built.registrations.map(function (reg) {
        return d.engine.register(reg.url, reg.table);
      })).then(function () {
        return d.engine.sql(built.sql);
      }).then(function (raw) {
        // Exact radius, measured on the ground rather than in the projection.
        //
        // ⚠️ THE CUTOFF USES THE UNROUNDED DISTANCE. Rounding first and comparing the rounded
        // value lets anything within half a metre outside the radius round down and pass, so a
        // "within 10 miles" answer quietly includes buildings that are not. It is a small error
        // but it is the wrong KIND of error: everywhere else the slack is deliberately biased
        // toward including a building that really is inside, never toward claiming one that is
        // outside. Rounding is presentation, so it happens after the cut.
        var rows = raw.map(function (r) {
          return {
            building_id: r.building_id, county: r.county,
            composite: r.composite, wf_score: r.wf_score, hail_score: r.hail_score,
            flood_score: r.flood_score, wind_score: r.wind_score, access_score: r.access_score,
            lon: r.lon, lat: r.lat,
            dist_m: geodesic(value.center.lat, value.center.lon, r.lat, r.lon)
          };
        }).filter(function (r) { return r.dist_m <= value.radius_m; });

        // If the over-fetch was exhausted the answer could be short, so say so rather than
        // presenting a truncated list as the top N. Compared against the limit sqlbuild ACTUALLY
        // used: a hardcoded number here cannot fire, because the SQL never asks for that many.
        if (raw.length >= built.fetchLimit && rows.length < value.limit) {
          notices.push("This query hit the internal row cap, so the list may be incomplete. " +
                       "Try a smaller radius.");
        }
        // Round for display only, once the exact distances have decided membership.
        rows = rows.slice(0, value.limit).map(function (r) {
          r.dist_m = Math.round(r.dist_m);
          return r;
        });

        return result(ctx, value, rows, counties, built.prune, notices, null);
      });
    }).catch(function (err) {
      return { ok: false, errors: [(err && err.message) || String(err)] };
    });
  }

  return { geodesic: geodesic, sphericalFallback: sphericalFallback, DISCLOSURE: DISCLOSURE, makeManifestLoader: makeManifestLoader,
           run: run, geocode: gazetteer.geocode };
});

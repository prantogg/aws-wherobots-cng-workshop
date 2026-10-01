/**
 * Colorado-only gazetteer for the copilot's `geocode` tool.
 *
 * ⚠️ COLORADO ONLY, DELIBERATELY. This app carries Colorado data and nothing else, so a place
 * outside the state is a question the extract cannot answer. Returning a point anyway would put
 * a marker where there is no data and read as "no risk here", which is the opposite of the
 * truth. Unknown places are REJECTED with the list of what is known, not approximated.
 *
 * Coordinates are city centres (the US Census place centroid, rounded to 4 decimals, roughly
 * 10 m), plus a few landmarks people actually ask about. "downtown <city>" resolves to the
 * city centre, which is what the phrase means at a 10-mile radius.
 *
 * The real fix for free-form places is an Overture places extract queried through the same
 * engine. This list exists so v1 can answer the questions people actually ask without that.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.CoRiskQuery = root.CoRiskQuery || {}).gazetteer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * ⚠️ EVERY LOOKUP USES has(), NEVER A BARE `PLACES[key]`.
   *
   * A plain object inherits `constructor`, `__proto__` and friends from Object.prototype, so
   * `PLACES["constructor"]` is truthy and the lookup "succeeds" with a value that is not a
   * place. geocode("constructor") returned `{ok:true, center:{}}`: the tool told the copilot the
   * place resolved and handed it an empty centre. A confident wrong answer, which is exactly
   * what this file's unknown-place rejection exists to prevent.
   *
   * Only lower-cased keys reach here (normalize() lower-cases), which is why `toString` and
   * `hasOwnProperty` happened not to collide while `constructor` and `__proto__` did. That is
   * luck, not a design, so the guard is on the lookup rather than on the spelling.
   */
  function has(key) { return Object.prototype.hasOwnProperty.call(PLACES, key); }

  var PLACES = {
    "denver": [-104.9903, 39.7392], "colorado springs": [-104.8214, 38.8339],
    "aurora": [-104.8319, 39.7294], "fort collins": [-105.0844, 40.5853],
    "lakewood": [-105.0814, 39.7047], "thornton": [-104.9719, 39.8681],
    "arvada": [-105.0875, 39.8028], "westminster": [-105.0372, 39.8367],
    "pueblo": [-104.6091, 38.2544], "centennial": [-104.8319, 39.5807],
    "boulder": [-105.2705, 40.0150], "greeley": [-104.7091, 40.4233],
    "longmont": [-105.1019, 40.1672], "loveland": [-105.0777, 40.3978],
    "broomfield": [-105.0866, 39.9205], "grand junction": [-108.5506, 39.0639],
    "castle rock": [-104.8561, 39.3722], "commerce city": [-104.9339, 39.8083],
    "parker": [-104.7614, 39.5186], "littleton": [-105.0166, 39.6133],
    "northglenn": [-104.9811, 39.8856], "brighton": [-104.8206, 39.9853],
    "englewood": [-104.9878, 39.6478], "wheat ridge": [-105.0772, 39.7661],
    "fountain": [-104.7008, 38.6822], "lafayette": [-105.0897, 39.9936],
    "montrose": [-107.8762, 38.4783], "durango": [-107.8801, 37.2753],
    "golden": [-105.2211, 39.7555], "louisville": [-105.1319, 39.9778],
    "windsor": [-104.9014, 40.4775], "evans": [-104.6919, 40.3775],
    "erie": [-105.0500, 40.0502], "steamboat springs": [-106.8317, 40.4850],
    "vail": [-106.3742, 39.6403], "aspen": [-106.8175, 39.1911],
    "breckenridge": [-106.0384, 39.4817], "telluride": [-107.8123, 37.9375],
    "estes park": [-105.5217, 40.3772], "trinidad": [-104.5005, 37.1695],
    "alamosa": [-105.8700, 37.4695], "canon city": [-105.2425, 38.4409],
    "glenwood springs": [-107.3248, 39.5505], "sterling": [-103.2077, 40.6255],
    "fort morgan": [-103.8000, 40.2503], "cortez": [-108.5859, 37.3489],
    "craig": [-107.5462, 40.5153], "salida": [-106.0000, 38.5347],
    "gunnison": [-106.9253, 38.5458], "leadville": [-106.2925, 39.2508],
    "silverthorne": [-106.0725, 39.6303], "woodland park": [-105.0569, 38.9939],
    "monument": [-104.8728, 39.0917], "lone tree": [-104.8861, 39.5319],
    "superior": [-105.1686, 39.9528], "firestone": [-104.9361, 40.1180],
    "frederick": [-104.9361, 40.1017], "johnstown": [-104.9122, 40.3372],
    "wellington": [-105.0086, 40.7036], "berthoud": [-105.0811, 40.3083],
    "rocky mountain national park": [-105.6836, 40.3428],
    "denver international airport": [-104.6737, 39.8561],
    "dia": [-104.6737, 39.8561], "red rocks": [-105.2056, 39.6654],
    "garden of the gods": [-104.8697, 38.8783], "pikes peak": [-105.0442, 38.8409],
    "coors field": [-104.9942, 39.7559], "union station": [-105.0002, 39.7531],
    "cherry creek": [-104.9553, 39.7190], "capitol hill": [-104.9784, 39.7318],
    "rino": [-104.9847, 39.7700], "lodo": [-104.9994, 39.7520],
    "dtc": [-104.8917, 39.6272], "denver tech center": [-104.8917, 39.6272]
  };

  // Qualifier words, in TWO levels, because they are not equally safe to remove.
  //
  // ⚠️ LEVEL 2 CONTAINS "colorado", WHICH IS ALSO HALF OF "COLORADO SPRINGS". Removing it too
  // eagerly turns "downtown Colorado Springs" into "springs", which is ambiguous against
  // Steamboat and Glenwood, so the state's second-largest city stops resolving. Each level is
  // therefore tried in turn, and an exact match always wins over any further stripping.
  var POSITIONAL = /\b(downtown|the|area|city|of|in|near|around|greater|metro)\b/g;  // level 1
  var STATE = /\b(colorado|co|usa|us)\b/g;                                            // level 2

  /** Light normalize: case, punctuation, whitespace. Nothing removed. */
  function normalize(place) {
    return String(place == null ? "" : place)
      .toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  }

  function squeeze(k) { return k.replace(/\s+/g, " ").trim(); }

  /** The progressively stripped forms of a name, most literal first. */
  function forms(raw) {
    var lvl1 = squeeze(raw.replace(POSITIONAL, " "));
    var lvl2 = squeeze(lvl1.replace(STATE, " "));
    var out = [raw];
    if (lvl1 && out.indexOf(lvl1) === -1) out.push(lvl1);
    if (lvl2 && out.indexOf(lvl2) === -1) out.push(lvl2);
    return out;
  }

  /** Kept for callers that only want the aggressive form. */
  function stripNoise(key) {
    return squeeze(squeeze(key.replace(POSITIONAL, " ")).replace(STATE, " "));
  }

  /**
   * Word-sequence containment, so a match has to align to whole words.
   * Substring matching alone accepts nonsense: "ver" would match "denver", and "the" matched
   * "garden of the gods" as the single hit and resolved to it.
   */
  function containsWords(hay, needle) {
    var h = hay.split(" "), n = needle.split(" ");
    if (!n.length || n.length > h.length) return false;
    for (var i = 0; i + n.length <= h.length; i++) {
      var all = true;
      for (var j = 0; j < n.length; j++) { if (h[i + j] !== n[j]) { all = false; break; } }
      if (all) return true;
    }
    return false;
  }

  /**
   * Resolve a place name to { ok, center } or { ok:false, error }.
   * Exact match first, then a unique substring match. An AMBIGUOUS substring is rejected rather
   * than guessed: silently picking one of several places puts the answer somewhere the user did
   * not ask about, and the rest of the pipeline has no way to notice.
   */
  function geocode(place) {
    var raw = normalize(place);
    if (!raw) return { ok: false, error: "no place given" };
    var hit = function (k) {
      return { ok: true, name: k, center: { lon: PLACES[k][0], lat: PLACES[k][1] } };
    };

    // A query made only of qualifiers carries no location at all. Without this, "the" reaches
    // substring matching, hits "garden of the gods" as its only candidate, and resolves to it:
    // a confident point for a question that named no place.
    if (!stripNoise(raw)) {
      return { ok: false, error: "no place given (that is only a qualifier, not a place name)" };
    }

    var candidates = forms(raw);
    // Exact match at ANY strip level wins outright, before substring matching is considered.
    for (var i = 0; i < candidates.length; i++) {
      if (has(candidates[i])) return hit(candidates[i]);
    }

    var ambiguous = null;
    for (var j = 0; j < candidates.length; j++) {
      var key = candidates[j];
      if (!key) continue;
      var hits = Object.keys(PLACES).filter(function (k) {
        return containsWords(k, key) || containsWords(key, k);
      });
      if (hits.length > 1) {
        var starts = hits.filter(function (k) {
          return key.indexOf(k) === 0 || k.indexOf(key) === 0;
        });
        if (starts.length === 1) hits = starts;
      }
      if (hits.length === 1) return hit(hits[0]);
      // Remember the first ambiguity, but keep trying the stripped forms: a later form may
      // resolve cleanly, and only if none does is ambiguity the answer.
      if (hits.length > 1 && !ambiguous) ambiguous = hits;
    }

    if (ambiguous) {
      return { ok: false, ambiguous: ambiguous.slice(0, 8),
               error: "\"" + place + "\" matches several places: " +
                      ambiguous.slice(0, 8).join(", ") + ". Ask for one of those." };
    }
    return { ok: false,
             error: "\"" + place + "\" is not in the Colorado gazetteer. This map carries " +
                    "Colorado data only, so places outside the state cannot be answered." };
  }

  var NEED_CENTRE = "query_properties needs a Colorado place name (place), or BOTH lon and lat.";

  /**
   * The query centre from query_properties' arguments. The model may pass a place name, a
   * lon/lat pair, or both.
   *
   * ⚠️ EXPLICIT COORDINATES ALWAYS WIN. The gazetteer fills the centre only when NEITHER lon nor
   * lat is given. A place plus a lone lon or lat is an INCOMPLETE centre and is refused, never
   * completed or overwritten from the gazetteer: mixing one explicit axis with one geocoded axis
   * would put the query at a point nobody asked for, and the answer would still look right.
   *
   * Returns { ok:true, lon, lat, label, source:"coordinates"|"place" } or { ok:false, error }.
   * `label` is the caller's place_label, else the gazetteer name for a geocoded centre. A place
   * name is NOT used to label explicit coordinates, because they need not be that place.
   */
  function resolveCentre(args) {
    var a = args || {};
    var hasLon = a.lon != null, hasLat = a.lat != null;
    if (hasLon && hasLat) {
      return { ok: true, lon: a.lon, lat: a.lat, label: a.place_label || null,
               source: "coordinates" };
    }
    if (hasLon || hasLat) return { ok: false, error: NEED_CENTRE };
    if (a.place) {
      var g = geocode(a.place);
      if (!g.ok) return { ok: false, error: g.error };
      return { ok: true, lon: g.center.lon, lat: g.center.lat, label: a.place_label || g.name,
               source: "place" };
    }
    return { ok: false, error: NEED_CENTRE };
  }

  return { PLACES: PLACES, has: has, normalize: normalize, forms: forms, stripNoise: stripNoise,
           containsWords: containsWords, geocode: geocode, resolveCentre: resolveCentre };
});

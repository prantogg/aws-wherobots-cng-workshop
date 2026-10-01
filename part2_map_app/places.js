// Place rollup: cities, Census Designated Places and "Unincorporated <County> County"
// remainders, built by pipelines/co-risk/analysis/04_places.py. Every scored building is in
// exactly ONE place, so place totals reconcile to the statewide 2,771,126.
//
// Pure functions only (no map, no DOM), so the ranking the copilot reports is the same code
// the tests run against the real published file. index.html owns the map side.
//
// Counts are FLOORS: the Overture-derived building spine is not a structure census.
(function(root){
  "use strict";

  // Peril -> rollup field. "Elevated" is the hex/co_hex definition, reused exactly:
  // wf_score 2, hail_score 2, flood/wind/access score 1 (access includes NULL = furthest).
  const ELEV = { wildfire:"wf_elev", hail:"hail_elev", flood:"flood_elev",
                 wind:"wind_elev", access:"access_elev", any:"any_elev" };
  const PERIL_KEYS = ["wildfire", "hail", "flood", "wind", "access"];
  const TYPES = { city:["city"], cdp:["cdp"], any:["city", "cdp", "remainder"] };

  // Share ranking only: a place needs at least this many buildings to be ranked by share,
  // otherwise a 3-building hamlet at 100% outranks a city. The value is derived from the
  // published distribution (see pipelines/co-risk/README.md "Places"); it is a constant here
  // so the tool, the tests and the README all quote one number.
  const SHARE_MIN_BUILDINGS = 500;

  const norm = s => String(s == null ? "" : s).toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\bcounty\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  function share(row, field){ return row.buildings > 0 ? row[field] / row.buildings : 0; }

  function inCounty(row, county){
    const want = norm(county);
    return (row.counties || [row.county]).some(c => norm(c) === want);
  }

  // Rank places for one peril. Returns {ok, ...} or {ok:false, error}.
  //   by:"count" (default) ranks by elevated buildings, share breaks ties;
  //   by:"share" ranks by elevated share among places with >= min_buildings.
  function rank(rows, opts){
    opts = opts || {};
    const peril = String(opts.peril || "").toLowerCase();
    const field = ELEV[peril];
    if(!field) return {ok:false, error:"unknown peril: " + opts.peril +
      " (use wildfire, hail, flood, wind, access, or any)"};
    const by = opts.by === "share" ? "share" : "count";
    if(opts.type != null && !TYPES[opts.type]) return {ok:false, error:"unknown place type: " + opts.type +
      " (use city, cdp, or any)"};
    const type = opts.type == null ? "any" : opts.type;
    const n = Math.max(1, Math.min(25, (opts.n | 0) || 10));
    const minB = by === "share"
      ? Math.max(1, (opts.min_buildings | 0) || SHARE_MIN_BUILDINGS) : 1;

    let pool = rows.filter(r => TYPES[type].includes(r.type));
    let county = null;
    if(opts.county){
      county = String(opts.county).replace(/\s+county$/i, "").trim();
      pool = pool.filter(r => inCounty(r, county));
      if(!pool.length) return {ok:false, error:"no places found in county: " + opts.county};
    }
    pool = pool.filter(r => r.buildings >= minB);
    const ranked = pool.slice().sort((a, b) => by === "share"
      ? (share(b, field) - share(a, field)) || (b[field] - a[field]) || a.name.localeCompare(b.name)
      : (b[field] - a[field]) || (share(b, field) - share(a, field)) || a.name.localeCompare(b.name));
    const top = ranked.slice(0, n).map((r, i) => {
      const s = summary(r, peril, i + 1);
      // A county filter matches a place on ANY overlap, but place counts are never split by
      // county: say so on the row itself, so the number cannot pass for a county slice.
      if(county && r.counties && r.counties.length > 1)
        s.count_scope = "whole place (spans " + r.counties.join(", ") + "), not only " + county + " County";
      return s;
    });
    return { ok:true, peril, by, type, county, n:top.length, places_ranked:ranked.length,
             min_buildings: by === "share" ? minB : undefined, places:top };
  }

  // Compact row for the model: the ranked peril first, then every peril's elevated count
  // so "what are the risks there" is answerable without a second call.
  function summary(r, peril, rank){
    const o = { rank, name:r.name, type:r.type, county:r.county, buildings:r.buildings };
    if(peril){
      const f = ELEV[peril];
      o.elevated = r[f];
      o.share = +share(r, f).toFixed(3);
    }
    o.elevated_by_peril = {};
    o.share_by_peril = {};
    for(const k of PERIL_KEYS){
      o.elevated_by_peril[k] = r[ELEV[k]];
      o.share_by_peril[k] = +share(r, ELEV[k]).toFixed(3);
    }
    if(r.any_elev != null) o.elevated_any_peril = r.any_elev;
    if(r.multi_elev != null) o.elevated_two_plus_perils = r.multi_elev;
    if(r.counties && r.counties.length > 1) o.spans_counties = r.counties;
    o.lon = r.clon; o.lat = r.clat;
    return o;
  }

  // Resolve a free-text place name to ONE rollup row, or a list of candidates.
  // Exact name first, then "X County" / "unincorporated X" to the remainder, then prefix,
  // then substring. Ambiguity is returned, never guessed.
  function find(rows, name){
    const q = norm(name).replace(/^unincorporated\s+/, "");
    if(!q) return {ok:false, error:"no place name given"};
    const wantsRemainder = /county\s*$/i.test(String(name).trim()) || /^\s*unincorporated/i.test(String(name));
    const pick = list => list.length === 1 ? {ok:true, row:list[0]}
      : list.length > 1 ? {ok:false, error:"ambiguous place name: " + name,
                            candidates:list.slice(0, 8).map(r => r.name + " (" + r.type + ", " + r.county + ")")}
      : null;
    if(wantsRemainder){
      const rem = rows.filter(r => r.type === "remainder" && norm(r.county) === q);
      const hit = pick(rem); if(hit) return hit;
    }
    const exact = rows.filter(r => r.type !== "remainder" && norm(r.name) === q);
    let hit = pick(exact); if(hit) return hit;
    const pre = rows.filter(r => norm(r.name).startsWith(q));
    hit = pick(pre); if(hit) return hit;
    const sub = rows.filter(r => norm(r.name).includes(q));
    hit = pick(sub); if(hit) return hit;
    return {ok:false, error:"no Colorado place matches: " + name};
  }

  // places.json is columnar ({columns, places:[[...], ...]}); rebuild one object per place.
  function decode(json){
    const cols = json.columns;
    return json.places.map(a => {
      const o = {};
      cols.forEach((c, i) => { if(a[i] != null) o[c] = a[i]; });
      return o;
    });
  }

  const api = { ELEV, PERIL_KEYS, SHARE_MIN_BUILDINGS, rank, find, summary, share, decode };
  if(typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CoRiskPlaces = api;
})(typeof window !== "undefined" ? window : globalThis);

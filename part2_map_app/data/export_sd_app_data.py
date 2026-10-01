"""Export San Diego County Gold for the Part 2 map app (PMTiles + browser-queryable GeoParquet).

Layout follows Ben Pruden's CO risk explorer contract (pipelines/co-risk/export/10 and 40):
  <USER_S3_PATH>cng-app/v<YYYYMMDD>/
      tiles/sd_hex.pmtiles          H3 res-7 aggregates
      tiles/sd_buildings.pmtiles    building footprints, z14-16
      tiles/sd_places.pmtiles       incorporated city boundaries
      query/manifest.json           per-file bbox + counts (the browser HEADs and reads it)
      query/cell=<h3_5>/part.parquet  one file per H3 res-5 cell, sorted by (h3_6, h3_7)
      app/hexes.json, app/places.json   small files the app ships

Rules carried over: geometry for the query extract is EPSG:5070 centroids as standard WKB
(ST_AsBinary), each file keeps its partition column as data, rows are sorted by H3 so row-group
statistics prune, the row-group budget is small, and nothing licensed is selected.
"""
import json
import os
import time
import uuid

from sedona.spark import SedonaContext

sedona = SedonaContext.create(
    SedonaContext.builder().config("spark.speculation", "false").getOrCreate())
sc = sedona.sparkContext
jvm, hconf = sedona._jvm, sedona._jsc.hadoopConfiguration()

BASE = os.environ["USER_S3_PATH"].rstrip("/") + "/"
VERSION = time.strftime("%Y%m%d", time.gmtime())
ROOT = f"{BASE}cng-app/v{VERSION}/"
GOLD = "org_catalog.gold"
OVR = "wherobots_open_data.overture_maps_foundation"
PARQUET_BLOCK_BYTES = 137_500


def _path(p):
    return jvm.org.apache.hadoop.fs.Path(p)


def write_text(p, text):
    path = _path(p)
    out = path.getFileSystem(hconf).create(path, True)
    out.write(bytearray(text.encode("utf-8")))
    out.close()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- building spine
spine = sedona.sql(f"""
  SELECT i.asset_id AS building_id, i.geometry,
         ST_Centroid(i.geometry) AS c0,
         i.building_class,
         i.wildfire_factor, i.flood_factor, i.severe_weather_factor,
         i.risk_score AS ins_score, i.risk_tier AS ins_tier,
         c.risk_score AS cre_score, c.risk_tier AS cre_tier,
         m.risk_score AS cap_score, m.disruption_signal,
         e.risk_score AS en_score, e.risk_tier AS en_tier, e.outage_probability
  FROM {GOLD}.insurance_exposure i
  JOIN {GOLD}.cre_risk c ON i.asset_id = c.asset_id
  JOIN {GOLD}.capital_markets_signals m ON i.asset_id = m.asset_id
  JOIN {GOLD}.energy_asset_risk e ON i.asset_id = e.asset_id
""")
spine.createOrReplaceTempView("spine")
TOTAL = sedona.table(f"{GOLD}.insurance_exposure").count()
log(f"gold buildings: {TOTAL:,}")

# ---------------------------------------------------------------- places (Overture)
sedona.sql(f"""
  CREATE OR REPLACE TEMP VIEW county AS
  SELECT geometry AS g FROM {OVR}.divisions_division_area
  WHERE country='US' AND region='US-CA' AND subtype='county'
    AND names.primary='San Diego County' AND class='land'
""")
sedona.sql(f"""
  CREATE OR REPLACE TEMP VIEW cities AS
  SELECT d.names.primary AS place, d.geometry AS g
  FROM {OVR}.divisions_division_area d, county c
  WHERE d.country='US' AND d.region='US-CA' AND d.subtype='locality' AND d.class='land'
    AND ST_Intersects(d.geometry, c.g)
    AND ST_Area(ST_Intersection(d.geometry, c.g)) > 0.5 * ST_Area(d.geometry)
""")
sedona.sql(f"""
  CREATE OR REPLACE TEMP VIEW communities AS
  SELECT DISTINCT d.names.primary AS place, d.geometry AS p
  FROM {OVR}.divisions_division d, county c
  WHERE d.country='US' AND d.region='US-CA' AND d.subtype='locality'
    AND ST_Intersects(d.geometry, c.g)
    AND NOT EXISTS (SELECT 1 FROM cities k WHERE ST_Intersects(d.geometry, k.g))
""")
log(f"places: {sedona.table('cities').count()} cities, {sedona.table('communities').count()} communities")

sedona.sql("""
  CREATE OR REPLACE TEMP VIEW in_city AS
  SELECT s.building_id, k.place
  FROM spine s JOIN cities k ON ST_Intersects(s.c0, k.g)
""")
sedona.sql("""
  CREATE OR REPLACE TEMP VIEW near_community AS
  SELECT building_id, place FROM (
    SELECT s.building_id, m.place,
           ROW_NUMBER() OVER (PARTITION BY s.building_id
                              ORDER BY ST_DistanceSphere(s.c0, m.p), m.place) AS rk
    FROM spine s CROSS JOIN communities m
    WHERE s.building_id NOT IN (SELECT building_id FROM in_city)
      AND ST_DistanceSphere(s.c0, m.p) <= 10000
  ) WHERE rk = 1
""")
b = sedona.sql("""
  SELECT s.*,
         COALESCE(ic.place, nc.place, 'Unincorporated San Diego County') AS place,
         CASE WHEN ic.place IS NOT NULL THEN 'city'
              WHEN nc.place IS NOT NULL THEN 'community' ELSE 'unincorporated' END AS place_type,
         ST_X(s.c0) AS lon, ST_Y(s.c0) AS lat,
         element_at(ST_H3CellIDs(s.c0, 5, false), 1) AS h3_5,
         element_at(ST_H3CellIDs(s.c0, 6, false), 1) AS h3_6,
         element_at(ST_H3CellIDs(s.c0, 7, false), 1) AS h3_7
  FROM spine s
  LEFT JOIN (SELECT building_id, FIRST(place) place FROM in_city GROUP BY building_id) ic
         ON s.building_id = ic.building_id
  LEFT JOIN near_community nc ON s.building_id = nc.building_id
""").persist()
b.createOrReplaceTempView("b")
n = b.count()
log(f"[{'PASS' if n == TOTAL else 'FAIL'}] spine rows {n:,} (gold {TOTAL:,})")
assert n == TOTAL, "spine lost or duplicated buildings"

# ---------------------------------------------------------------- query extract
QCOLS = ["building_id", "geom_5070", "place", "ins_score", "ins_tier", "cre_score", "cre_tier",
         "cap_score", "en_score", "en_tier", "wildfire_factor", "flood_factor",
         "severe_weather_factor", "outage_probability", "lon", "lat", "h3_5", "h3_6", "h3_7"]
q = sedona.sql("""
  SELECT building_id,
         ST_AsBinary(ST_Transform(c0, 'EPSG:4326', 'EPSG:5070')) AS geom_5070,
         place, ins_score, ins_tier, cre_score, cre_tier, cap_score, en_score, en_tier,
         wildfire_factor, flood_factor, severe_weather_factor, outage_probability,
         lon, lat, h3_5, h3_6, h3_7
  FROM b
""")
assert q.columns == QCOLS, q.columns
cells = [r["h3_5"] for r in q.select("h3_5").distinct().orderBy("h3_5").collect()]
log(f"query extract: {len(cells)} H3 res-5 files")
files, written = [], 0
for cell in cells:
    part = q.where(q.h3_5 == cell)
    tmp = f"{ROOT}query/_tmp_{cell}/"
    (part.repartition(1).sortWithinPartitions("h3_6", "h3_7")
         .write.option("parquet.block.size", PARQUET_BLOCK_BYTES).mode("overwrite").parquet(tmp))
    src = _path(tmp)
    fs = src.getFileSystem(hconf)
    parts = [s.getPath() for s in fs.globStatus(_path(tmp + "part-*.parquet"))]
    assert len(parts) == 1, (cell, len(parts))
    dst = _path(f"{ROOT}query/cell={cell}/part.parquet")
    fs.mkdirs(dst.getParent())
    assert fs.rename(parts[0], dst), f"rename failed for {cell}"
    fs.delete(src, True)
    st = part.selectExpr("COUNT(*) n", "MIN(lon) xmin", "MAX(lon) xmax", "MIN(lat) ymin",
                         "MAX(lat) ymax", "concat_ws('|', sort_array(collect_set(place))) places").collect()[0]
    files.append({"key": f"cell={cell}/part.parquet", "h3_5": str(cell), "rows": st["n"],
                  "bbox": [round(st["xmin"], 5), round(st["ymin"], 5), round(st["xmax"], 5), round(st["ymax"], 5)],
                  "places": st["places"].split("|")})
    written += st["n"]
log(f"[{'PASS' if written == TOTAL else 'FAIL'}] extract rows {written:,}")
assert written == TOTAL
write_text(f"{ROOT}query/manifest.json", json.dumps({
    "version": VERSION, "rows": TOTAL, "columns": QCOLS, "crs": "EPSG:5070 (geom_5070, centroid WKB)",
    "partition": "H3 res 5 (h3_5); rows sorted by h3_6, h3_7",
    "disclosure": "Risk tiers are percentile ranks within San Diego County; scores are screening "
                  "signals from the workshop pipeline, not insurability determinations.",
    "files": files}, indent=1))
log("wrote query/manifest.json")

# ---------------------------------------------------------------- app data files
hexes = sedona.sql("""
  SELECT CAST(h3_7 AS STRING) id, ROUND(AVG(lon), 4) lon, ROUND(AVG(lat), 4) lat,
         MODE(place) pl, COUNT(*) b,
         SUM(CASE WHEN ins_tier='critical' THEN 1 ELSE 0 END) ic,
         SUM(CASE WHEN ins_tier='high' THEN 1 ELSE 0 END) ih,
         SUM(CASE WHEN cre_tier='critical' THEN 1 ELSE 0 END) cc,
         SUM(CASE WHEN en_tier='critical' THEN 1 ELSE 0 END) ec,
         ROUND(AVG(ins_score), 4) s_ins, ROUND(AVG(cre_score), 4) s_cre,
         ROUND(AVG(cap_score), 4) s_cap, ROUND(AVG(en_score), 4) s_en,
         ROUND(AVG(wildfire_factor), 4) wf,
         ROUND(AVG(flood_factor), 4) fl, ROUND(AVG(severe_weather_factor), 4) sw
  FROM b GROUP BY h3_7
""").collect()
write_text(f"{ROOT}app/hexes.json", json.dumps([r.asDict() for r in hexes], separators=(",", ":")))
places = sedona.sql("""
  SELECT place, FIRST(place_type) type, COUNT(*) buildings,
         ROUND(AVG(lon), 4) lon, ROUND(AVG(lat), 4) lat,
         ROUND(MIN(lon), 4) xmin, ROUND(MIN(lat), 4) ymin, ROUND(MAX(lon), 4) xmax, ROUND(MAX(lat), 4) ymax,
         SUM(CASE WHEN ins_tier='critical' THEN 1 ELSE 0 END) ins_critical,
         SUM(CASE WHEN ins_tier='high' THEN 1 ELSE 0 END) ins_high,
         SUM(CASE WHEN cre_tier='critical' THEN 1 ELSE 0 END) cre_critical,
         SUM(CASE WHEN en_tier='critical' THEN 1 ELSE 0 END) en_critical,
         ROUND(AVG(ins_score), 4) avg_ins_score, ROUND(AVG(cre_score), 4) avg_cre_score,
         ROUND(AVG(cap_score), 4) avg_cap_score, ROUND(AVG(en_score), 4) avg_en_score,
         ROUND(AVG(wildfire_factor), 4) avg_wildfire,
         ROUND(AVG(flood_factor), 4) avg_flood, ROUND(AVG(severe_weather_factor), 4) avg_severe_weather,
         SUM(CASE WHEN wildfire_factor > 0 THEN 1 ELSE 0 END) wildfire_exposed
  FROM b GROUP BY place ORDER BY buildings DESC
""").collect()
plist = [r.asDict() for r in places]
assert sum(p["buildings"] for p in plist) == TOTAL
write_text(f"{ROOT}app/places.json", json.dumps({"total_buildings": TOTAL, "places": plist}, indent=1))
log(f"wrote app/hexes.json ({len(hexes):,} cells) and app/places.json ({len(plist)} places)")

# ---------------------------------------------------------------- PMTiles
from wherobots import vtiles

sc.setCheckpointDir(f"{BASE}tilegen-ckpt/{uuid.uuid4().hex}/")
hex_df = sedona.sql("""
  SELECT 'hex' AS layer, element_at(ST_H3ToGeom(array(h3_7)), 1) AS geometry,
         CAST(h3_7 AS STRING) AS h3, MODE(place) AS place, COUNT(*) AS buildings,
         SUM(CASE WHEN ins_tier='critical' THEN 1 ELSE 0 END) AS ins_critical,
         SUM(CASE WHEN ins_tier='high' THEN 1 ELSE 0 END) AS ins_high,
         SUM(CASE WHEN cre_tier='critical' THEN 1 ELSE 0 END) AS cre_critical,
         SUM(CASE WHEN en_tier='critical' THEN 1 ELSE 0 END) AS en_critical,
         AVG(ins_score) AS avg_ins_score, AVG(cre_score) AS avg_cre_score,
         AVG(cap_score) AS avg_cap_score, AVG(en_score) AS avg_en_score,
         AVG(wildfire_factor) AS avg_wildfire, AVG(flood_factor) AS avg_flood,
         AVG(severe_weather_factor) AS avg_severe_weather
  FROM b GROUP BY h3_7
""")
t0 = time.time(); vtiles.generate_pmtiles(hex_df, f"{ROOT}tiles/sd_hex.pmtiles")
log(f"wrote tiles/sd_hex.pmtiles in {time.time()-t0:.0f}s")

places_df = sedona.sql("SELECT 'places' AS layer, g AS geometry, place FROM cities")
t0 = time.time(); vtiles.generate_pmtiles(places_df, f"{ROOT}tiles/sd_places.pmtiles")
log(f"wrote tiles/sd_places.pmtiles in {time.time()-t0:.0f}s")

bld_df = sedona.sql("""
  SELECT 'buildings' AS layer, geometry, building_id, place, building_class,
         ins_tier, cre_tier, en_tier,
         ROUND(ins_score, 4) ins_score, ROUND(cre_score, 4) cre_score,
         ROUND(cap_score, 4) cap_score, ROUND(en_score, 4) en_score,
         ROUND(wildfire_factor, 4) wildfire_factor, ROUND(flood_factor, 4) flood_factor,
         ROUND(severe_weather_factor, 4) severe_weather_factor,
         ROUND(outage_probability, 4) outage_probability
  FROM b
""")
t0 = time.time()
vtiles.generate_pmtiles(bld_df, f"{ROOT}tiles/sd_buildings.pmtiles",
                        vtiles.GenerationConfig(min_zoom=14, max_zoom=16, max_features_per_tile=200_000))
log(f"wrote tiles/sd_buildings.pmtiles in {time.time()-t0:.0f}s")
log(f"DONE {ROOT}")

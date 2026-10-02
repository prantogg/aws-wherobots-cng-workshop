"""Building tiles for the Part 2 map app: all-building dots (z9-12) and footprints (z12-16).

Shares the spine and place assignment with export_sd_app_data.py; writes only
<USER_S3_PATH>cng-app/v<YYYYMMDD>/tiles/{sd_points,sd_buildings}.pmtiles. The query extract,
hex and place tiles, and the app JSON files are unchanged and stay on their own version.

Original export docstring:

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


# ---------------------------------------------------------------- tiles
from wherobots import vtiles

sc.setCheckpointDir(f"{BASE}tilegen-ckpt/{uuid.uuid4().hex}/")
TIER_INT = "CASE {c} WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'elevated' THEN 2 WHEN 'moderate' THEN 1 ELSE 0 END"
pct = lambda c: f"CAST(ROUND(COALESCE({c}, 0) * 100) AS INT)"
points = sedona.sql(f"""
  SELECT 'points' AS layer, c0 AS geometry,
         {TIER_INT.format(c="ins_tier")} AS ins_t, {TIER_INT.format(c="cre_tier")} AS cre_t,
         {TIER_INT.format(c="en_tier")} AS en_t,
         {pct("ins_score")} AS ins_s, {pct("cre_score")} AS cre_s, {pct("cap_score")} AS cap_s,
         {pct("en_score")} AS en_s, {pct("wildfire_factor")} AS wf, {pct("flood_factor")} AS fl,
         {pct("severe_weather_factor")} AS sw
  FROM b
""")
n_pts = points.count()
assert n_pts == TOTAL, (n_pts, TOTAL)
t0 = time.time()
vtiles.generate_pmtiles(points, f"{ROOT}tiles/sd_points.pmtiles",
                        vtiles.GenerationConfig(min_zoom=9, max_zoom=12, max_features_per_tile=1_200_000))
log(f"wrote tiles/sd_points.pmtiles ({n_pts:,} points) in {time.time()-t0:.0f}s")

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
                        vtiles.GenerationConfig(min_zoom=12, max_zoom=16, max_features_per_tile=400_000))
log(f"wrote tiles/sd_buildings.pmtiles (z12-16) in {time.time()-t0:.0f}s")
log(f"DONE {ROOT}")

"""Export the City of San Diego Gold for the Part 2 map app (PMTiles + the app's JSON files).

Reads org_catalog.gold as Part 1 writes it (City of San Diego AOI) and writes
<USER_S3_PATH>cng-app/v<YYYYMMDD>/:
    tiles/sd_points.pmtiles       every building as a dot, z9-12
    tiles/sd_buildings.pmtiles    building footprints, z12-16
    tiles/sd_hex.pmtiles          H3 res-8 aggregates
    tiles/sd_places.pmtiles       the city boundary
    app/hexes.json, app/places.json   small files the app ships

Building-level questions are not served from here: the app runs them against each participant's
own Gold tables through the Wherobots MCP (serve.py). Places are Overture macrohoods (the
community names people use: La Jolla, North Park, Tierrasanta): each building takes the nearest
macrohood point inside the city. Overture's finer `neighborhood` points are too patchy to name by.
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
  CREATE OR REPLACE TEMP VIEW city AS
  SELECT geometry AS g FROM {OVR}.divisions_division_area
  WHERE country='US' AND region='US-CA' AND subtype='locality' AND class='land'
    AND names.primary='San Diego'
""")
assert sedona.table("city").count() == 1, "expected one City of San Diego boundary"
sedona.sql(f"""
  CREATE OR REPLACE TEMP VIEW hoods AS
  SELECT DISTINCT d.names.primary AS place, d.geometry AS p
  FROM {OVR}.divisions_division d, city c
  WHERE d.country='US' AND d.region='US-CA' AND d.subtype='macrohood'
    AND ST_Intersects(d.geometry, c.g)
""")
log(f"places: {sedona.table('hoods').count()} Overture neighbourhoods in the city")

sedona.sql("""
  CREATE OR REPLACE TEMP VIEW nearest AS
  SELECT building_id, place FROM (
    SELECT s.building_id, h.place,
           ROW_NUMBER() OVER (PARTITION BY s.building_id
                              ORDER BY ST_DistanceSphere(s.c0, h.p), h.place) AS rk
    FROM spine s CROSS JOIN hoods h
  ) WHERE rk = 1
""")
b = sedona.sql("""
  SELECT s.*, COALESCE(n.place, 'San Diego') AS place, 'neighborhood' AS place_type,
         ST_X(s.c0) AS lon, ST_Y(s.c0) AS lat,
         element_at(ST_H3CellIDs(s.c0, 8, false), 1) AS h3_8
  FROM spine s LEFT JOIN nearest n ON s.building_id = n.building_id
""").persist()
b.createOrReplaceTempView("b")
n = b.count()
log(f"[{'PASS' if n == TOTAL else 'FAIL'}] spine rows {n:,} (gold {TOTAL:,})")
assert n == TOTAL, "spine lost or duplicated buildings"

# ---------------------------------------------------------------- app data files
hexes = sedona.sql("""
  SELECT CAST(h3_8 AS STRING) id, ROUND(AVG(lon), 4) lon, ROUND(AVG(lat), 4) lat,
         MODE(place) pl, COUNT(*) b,
         SUM(CASE WHEN ins_tier='critical' THEN 1 ELSE 0 END) ic,
         SUM(CASE WHEN ins_tier='high' THEN 1 ELSE 0 END) ih,
         SUM(CASE WHEN cre_tier='critical' THEN 1 ELSE 0 END) cc,
         SUM(CASE WHEN en_tier='critical' THEN 1 ELSE 0 END) ec,
         ROUND(AVG(ins_score), 4) s_ins, ROUND(AVG(cre_score), 4) s_cre,
         ROUND(AVG(cap_score), 4) s_cap, ROUND(AVG(en_score), 4) s_en,
         ROUND(AVG(wildfire_factor), 4) wf,
         ROUND(AVG(flood_factor), 4) fl, ROUND(AVG(severe_weather_factor), 4) sw
  FROM b GROUP BY h3_8
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
  SELECT 'hex' AS layer, element_at(ST_H3ToGeom(array(h3_8)), 1) AS geometry,
         CAST(h3_8 AS STRING) AS h3, MODE(place) AS place, COUNT(*) AS buildings,
         SUM(CASE WHEN ins_tier='critical' THEN 1 ELSE 0 END) AS ins_critical,
         SUM(CASE WHEN ins_tier='high' THEN 1 ELSE 0 END) AS ins_high,
         SUM(CASE WHEN cre_tier='critical' THEN 1 ELSE 0 END) AS cre_critical,
         SUM(CASE WHEN en_tier='critical' THEN 1 ELSE 0 END) AS en_critical,
         AVG(ins_score) AS avg_ins_score, AVG(cre_score) AS avg_cre_score,
         AVG(cap_score) AS avg_cap_score, AVG(en_score) AS avg_en_score,
         AVG(wildfire_factor) AS avg_wildfire, AVG(flood_factor) AS avg_flood,
         AVG(severe_weather_factor) AS avg_severe_weather
  FROM b GROUP BY h3_8
""")
t0 = time.time(); vtiles.generate_pmtiles(hex_df, f"{ROOT}tiles/sd_hex.pmtiles")
log(f"wrote tiles/sd_hex.pmtiles in {time.time()-t0:.0f}s")

places_df = sedona.sql("SELECT 'places' AS layer, g AS geometry, 'San Diego' AS place FROM city")
t0 = time.time(); vtiles.generate_pmtiles(places_df, f"{ROOT}tiles/sd_places.pmtiles")
log(f"wrote tiles/sd_places.pmtiles in {time.time()-t0:.0f}s")

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
t0 = time.time()
vtiles.generate_pmtiles(points, f"{ROOT}tiles/sd_points.pmtiles",
                        vtiles.GenerationConfig(min_zoom=9, max_zoom=12, max_features_per_tile=1_200_000))
log(f"wrote tiles/sd_points.pmtiles in {time.time()-t0:.0f}s")

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

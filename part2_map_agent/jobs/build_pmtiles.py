"""Build PMTiles of every building from your Gold tables (Wherobots job, about 3 minutes on Small).

The map agent's build_pmtiles tool uploads this script to your managed storage, fills in the
output folder, and submits it as a Wherobots job run. It writes two files to
<USER_S3_PATH>__OUT_DIR__/:
    sd_points.pmtiles     every building as a point, z9-12
    sd_buildings.pmtiles  every building footprint, z12-16
The agent's viewer then reads them through http://localhost:<port>/tiles/.
"""
import os
import time
import uuid

from sedona.spark import SedonaContext
from wherobots import vtiles

T0 = time.time()
sedona = SedonaContext.create(
    SedonaContext.builder().config("spark.speculation", "false").getOrCreate())


def log(msg):
    print(f"[{time.time() - T0:5.0f}s] {msg}", flush=True)


BASE = os.environ["USER_S3_PATH"].rstrip("/") + "/"
OUT = f"{BASE}__OUT_DIR__/"
GOLD = "org_catalog.gold"

b = sedona.sql(f"""
  SELECT i.asset_id AS building_id, i.geometry, ST_Centroid(i.geometry) AS c0, i.building_class,
         i.wildfire_factor, i.flood_factor, i.severe_weather_factor,
         i.risk_score AS ins_score, i.risk_tier AS ins_tier,
         c.risk_score AS cre_score, c.risk_tier AS cre_tier,
         m.risk_score AS cap_score,
         e.risk_score AS en_score, e.risk_tier AS en_tier, e.outage_probability
  FROM {GOLD}.insurance_exposure i
  JOIN {GOLD}.cre_risk c ON i.asset_id = c.asset_id
  JOIN {GOLD}.capital_markets_signals m ON i.asset_id = m.asset_id
  JOIN {GOLD}.energy_asset_risk e ON i.asset_id = e.asset_id
""").persist()
b.createOrReplaceTempView("b")
log(f"read {b.count():,} buildings from your Gold tables")

sedona.sparkContext.setCheckpointDir(f"{BASE}tilegen-ckpt/{uuid.uuid4().hex}/")
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
t = time.time()
vtiles.generate_pmtiles(points, f"{OUT}sd_points.pmtiles",
                        vtiles.GenerationConfig(min_zoom=9, max_zoom=12, max_features_per_tile=1_200_000))
log(f"wrote sd_points.pmtiles in {time.time() - t:.0f}s")

footprints = sedona.sql("""
  SELECT 'buildings' AS layer, geometry, building_id, building_class, ins_tier, cre_tier, en_tier,
         ROUND(ins_score, 4) ins_score, ROUND(cre_score, 4) cre_score,
         ROUND(cap_score, 4) cap_score, ROUND(en_score, 4) en_score,
         ROUND(wildfire_factor, 4) wildfire_factor, ROUND(flood_factor, 4) flood_factor,
         ROUND(severe_weather_factor, 4) severe_weather_factor,
         ROUND(outage_probability, 4) outage_probability
  FROM b
""")
t = time.time()
vtiles.generate_pmtiles(footprints, f"{OUT}sd_buildings.pmtiles",
                        vtiles.GenerationConfig(min_zoom=12, max_zoom=16, max_features_per_tile=400_000))
log(f"wrote sd_buildings.pmtiles in {time.time() - t:.0f}s")
log(f"DONE {OUT}")

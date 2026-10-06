---
name: open-mapping
description: Publish query results as MapLibre maps with write_layer and publish_map. Covers the map spec format, data-driven styling expressions, the risk tier palette, and follow-up edits.
allowed-tools: write_layer publish_map
---

# Open Mapping Skill

Maps are a small JSON "map spec" rendered by `viewer/index.html` (MapLibre GL JS on an
OpenFreeMap basemap). `write_layer` saves the data; `publish_map` saves the spec and returns
the URL.

## Map spec

```json
{
  "title": "Critical insurance buildings",
  "description": "8,412 buildings in the critical tier, coloured by wildfire factor.",
  "center": [-117.08, 32.86],
  "zoom": 11,
  "basemap": "dark",
  "sources": {
    "buildings": {"type": "geojson", "data": "buildings.geojson"}
  },
  "layers": [
    {"id": "buildings-fill", "type": "fill", "source": "buildings",
     "paint": {"fill-color": ["interpolate", ["linear"], ["get", "wildfire_factor"],
                              0, "#fee8c8", 0.2, "#fc8d59", 0.43, "#b30000"],
               "fill-opacity": 0.85}}
  ],
  "legend": [{"label": "wildfire 0", "color": "#fee8c8"},
             {"label": "0.2", "color": "#fc8d59"},
             {"label": "0.43", "color": "#b30000"}],
  "popup": ["asset_id", "risk_tier", "wildfire_factor"]
}
```

- `sources` and `layers` are standard MapLibre style-spec objects. GeoJSON `data` is the
  file name `write_layer` returned (relative to the map folder).
- `center` is `[lng, lat]`; take it from the write_layer summary. Zoom 11 fits the city,
  9 the county, 14+ a neighbourhood.
- `legend` must match the colours actually used in `paint`.
- `popup` lists the columns shown when a feature is clicked.

## Styling by geometry type

| Geometry | Layer type | Colour property |
|---|---|---|
| Polygon / MultiPolygon | `fill` plus a `line` layer on the same source with the same colour expression and `line-width` 1.5, so small buildings stay visible at city zoom | `fill-color`, `line-color` |
| Point | `circle` (`circle-radius` 3-6) | `circle-color` |
| LineString | `line` (`line-width` 1.5-3) | `line-color` |

## Data-driven colour

Numeric column: `interpolate` with stops from the write_layer summary (min, p50, max).
Never assume 0-1; if every value is identical, say so and colour by a different column.

```json
["interpolate", ["linear"], ["get", "risk_score"], 0.17, "#fee8c8", 0.19, "#fc8d59", 0.2, "#b30000"]
```

Categorical column: `match`, with a fallback colour last.

```json
["match", ["get", "risk_tier"],
  "critical", "#d7191c", "high", "#fdae61", "elevated", "#ffffbf",
  "moderate", "#a6d96a", "low", "#1a9641", "#888888"]
```

Always use this palette for `risk_tier` so maps stay comparable.

Sequential ramps for numbers: wildfire `#fee8c8 → #fc8d59 → #b30000`, flood
`#deebf7 → #6baed6 → #08306b`, generic `#ffffcc → #41b6c4 → #253494`.

## PMTiles (only when the user asks)

`write_layer` GeoJSON stays the default. Use PMTiles only when the user asks for PMTiles,
vector tiles, their own tiles or the workshop's pre-built tiles. A PMTiles file holds every
building in one file; the viewer reads it with HTTP range requests, so the browser fetches
only the tiles on screen, with no query and no 10,000-row cap.

**Their own tiles.** Call `build_pmtiles`. It runs a Wherobots job in the user's org (about 3
minutes) that writes `sd_points.pmtiles` and `sd_buildings.pmtiles` from their Gold tables to
their managed storage, and returns a `base` URL such as
`pmtiles://http://localhost:8765/tiles/<folder>/`. Use `base` + file name as the source `url`.
Same attributes as the table below; the footprints carry `building_class` and no `place`.
When you publish from them, explain in one or two plain sentences what happened: the tiles
were built from their own data on Wherobots, live as two files in their managed storage, and
the map reads only the parts on screen.

**The workshop's pre-built tiles** (Wherobots' public examples bucket, built by the workshop's
reference runs of Part 1, same inputs and notebooks; hazard factors are `insurance_exposure`'s):

| Set | Base URL | Covers | Use it when |
|---|---|---|---|
| City | `pmtiles://https://wherobots-examples.s3.us-west-2.amazonaws.com/aws-wherobots-cng-workshop/tiles/city/v20261004/` | City of San Diego, 357,263 buildings | The user asks for the pre-built tiles, or to compare their own tiles with the reference |
| County | `pmtiles://https://wherobots-examples.s3.us-west-2.amazonaws.com/aws-wherobots-cng-workshop/tiles/county/v20261002/` | All of San Diego County, 1,026,302 buildings | The user asks for the whole county or a place outside their data (Poway, Ramona, Julian) and agrees to use the pre-built county tiles. Offer them in one line when that comes up |

Scores and tiers are relative to the area each set was built from: a building can be critical
in the city set and only high in the county set. Never mix sets in one map, and when you use
the county set say "from the workshop's county tiles; tiers are relative to the whole county".
Don't use the pre-built sets if the participant ran Part 1 on a different area or changed the
weights.

Each pre-built set has four files; your own tiles have the first two:

| File | `source-layer` | Geometry, zooms | Attributes |
|---|---|---|---|
| `sd_points.pmtiles` | `points` | building centroids, z9-12 (stretches past 12) | `ins_t`, `cre_t`, `en_t`: tier as an integer, 4 critical, 3 high, 2 elevated, 1 moderate, 0 low. `ins_s`, `cre_s`, `cap_s`, `en_s`, `wf`, `fl`, `sw`: score or factor × 100, integers 0-100 |
| `sd_buildings.pmtiles` | `buildings` | footprints, z12-16 | `building_id`, `place`, `ins_tier`, `cre_tier`, `en_tier` (strings), `ins_score`, `cre_score`, `cap_score`, `en_score`, `wildfire_factor`, `flood_factor`, `severe_weather_factor`, `outage_probability` (0-1); the city set also has `building_class` |
| `sd_hex.pmtiles` | `hex` | H3 cells (res 8 city, res 7 county), z5-15 | `place`, `buildings`, `ins_critical`, `ins_high`, `cre_critical`, `en_critical`, `avg_ins_score`, `avg_cre_score`, `avg_cap_score`, `avg_en_score`, `avg_wildfire`, `avg_flood`, `avg_severe_weather` |
| `sd_places.pmtiles` | `places` | city: the city boundary; county: the 18 incorporated cities | `place` |

The usual whole-city map is dots up to zoom 12 and footprints from 12, on the same colour
rule. Points carry integers and footprints carry strings, so each layer needs its own
expression. Set `"zoom": 11` for the city or `"zoom": 9.5` for the county (points start at 9). This
example uses the city set:

```json
"sources": {
  "pts": {"type": "vector", "url": "pmtiles://https://wherobots-examples.s3.us-west-2.amazonaws.com/aws-wherobots-cng-workshop/tiles/city/v20261004/sd_points.pmtiles"},
  "bld": {"type": "vector", "url": "pmtiles://https://wherobots-examples.s3.us-west-2.amazonaws.com/aws-wherobots-cng-workshop/tiles/city/v20261004/sd_buildings.pmtiles"}
},
"layers": [
  {"id": "pts", "type": "circle", "source": "pts", "source-layer": "points", "maxzoom": 12,
   "filter": [">=", ["get", "ins_t"], 3],
   "paint": {"circle-radius": 2.5,
             "circle-color": ["match", ["get", "ins_t"], 4, "#d7191c", 3, "#fdae61", "#888888"]}},
  {"id": "bld", "type": "fill", "source": "bld", "source-layer": "buildings", "minzoom": 12,
   "filter": ["in", ["get", "ins_tier"], ["literal", ["critical", "high"]]],
   "paint": {"fill-color": ["match", ["get", "ins_tier"], "critical", "#d7191c", "high", "#fdae61", "#888888"],
             "fill-opacity": 0.85}}
]
```

Every vector layer needs `source-layer`. Filters and colours use MapLibre expressions on the
attributes above. Popups show the clicked feature's attributes, so list names from the table.
Use the hex tiles for averages by area, including below zoom 9 where the points stop.

## Large answers

The Wherobots MCP returns at most 10,000 rows (`truncated: true` in the summary). If the
user asks for every building, offer PMTiles (above). Otherwise narrow the filter, or
aggregate to H3 cells and colour the hexagons by count or mean:

```sql
SELECT h3, COUNT(*) AS buildings, AVG(risk_score) AS mean_risk,
       ST_H3ToGeom(array(h3))[0] AS geometry
FROM (SELECT explode(ST_H3CellIDs(ST_Centroid(geometry), 8, false)) AS h3, risk_score
      FROM org_catalog.gold.insurance_exposure)
GROUP BY h3
```

## Follow-ups

Reuse the map_id. Styling, basemap, zoom or legend changes need only `publish_map` with the
edited spec. A new filter or new columns needs `write_layer` first. Adding a second layer:
call `write_layer` with a new layer_id and add a second source and layer to the spec.

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

## Large answers

The Wherobots MCP returns at most 10,000 rows (`truncated: true` in the summary). Either
narrow the filter, or aggregate to H3 cells and colour the hexagons by count or mean:

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

#!/usr/bin/env python3
"""
Open Map Agent
==============

A Strands agent that answers questions over the Gold catalog tables with the
Wherobots MCP and publishes the answer as a MapLibre map.

  - Wherobots MCP: explore tables and test SQL
  - write_layer:   run the final SQL, save the result as GeoJSON under viewer/maps/<map_id>/
  - publish_map:   write viewer/maps/<map_id>/map.json and return the viewer URL
  - The viewer (viewer/index.html) is served locally on MAP_VIEWER_PORT.

Usage:
    python agent.py "Map critical insurance buildings colored by wildfire factor"
    python agent.py  # interactive mode
"""

import functools
import io
import json
import os
import re
import sys
import threading
import time
import urllib.request
import uuid
from datetime import timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

import geopandas as gpd
import pyarrow.parquet as pq
import shapely
import httpx2
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
from strands import Agent, AgentSkills, tool
from strands.tools.mcp import MCPClient
from strands.types.exceptions import MCPClientInitializationError

# ── Constants ──────────────────────────────────────────────────
VIEWER_DIR = Path(__file__).parent / "viewer"
MAPS_DIR = VIEWER_DIR / "maps"
VIEWER_PORT = int(os.environ.get("MAP_VIEWER_PORT", "8765"))
WHEROBOTS_MCP_URL = os.environ.get("WHEROBOTS_MCP_URL", "https://api.cloud.wherobots.com/mcp")
# Catalog database silver-to-gold writes the gold tables into (org_catalog.<GOLD_DB>.<table>).
GOLD_DB = os.environ.get("GOLD_DB", "gold")
# The Wherobots MCP returns at most this many rows per query.
MAX_ROWS = 10000
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

skills_plugin = AgentSkills(skills=str(Path(__file__).parent / "skills" / "open-mapping"))

wherobots_mcp = MCPClient(
    lambda: streamable_http_client(
        WHEROBOTS_MCP_URL,
        http_client=create_mcp_http_client(
            headers={"x-api-key": os.environ.get("WHEROBOTS_API_KEY", ""),
                     # SQL session runtime (e.g. "micro"); unset uses the organization's default.
                     **({"x-runtime-id": rid} if (rid := os.environ.get("WHEROBOTS_RUNTIME_ID")) else {})},
            timeout=httpx2.Timeout(60, read=300),
        ),
    )
)


# ── Wherobots MCP helpers ──────────────────────────────────────

def _mcp(name: str, arguments: dict) -> dict:
    """Call a Wherobots MCP tool and return its JSON payload."""
    r = wherobots_mcp.call_tool_sync(
        tool_use_id=f"map-{uuid.uuid4().hex[:8]}", name=name, arguments=arguments,
        read_timeout_seconds=timedelta(seconds=90),
    )
    text = "".join(c.get("text", "") for c in r.get("content", []) if isinstance(c, dict))
    if r.get("status") == "error":
        raise RuntimeError(f"{name} failed: {text[:500]}")
    payload = r.get("structuredContent") or json.loads(text)
    return payload.get("result", payload) if "status" not in payload else payload


def _run_query_to_parquet(sql: str) -> bytes:
    """Run SQL through the Wherobots MCP with store_results and download the Parquet result."""
    job = _mcp("submit_query_tool", {"query": sql, "store_results": True, "limit": MAX_ROWS, "wait_seconds": 50})
    while job.get("status") in ("pending", "starting_session", "running"):
        time.sleep(10)
        job = _mcp("get_query_status_tool", {"query_id": job["query_id"]})
    if job.get("status") != "succeeded":
        raise RuntimeError(f"query {job.get('status')}: {job.get('error_message')}")
    if not job.get("result_uri"):
        job = _mcp("get_query_results_tool", {"query_id": job["query_id"]})
    with urllib.request.urlopen(job["result_uri"], timeout=120) as resp:
        return resp.read()


def _summarize(gdf: gpd.GeoDataFrame) -> dict:
    """Column stats the agent uses to pick colour stops and legend labels."""
    columns = {}
    for col in gdf.columns.drop("geometry"):
        s = gdf[col]
        if s.dtype.kind in "iuf":
            q = s.quantile([0, 0.1, 0.5, 0.9, 1]).round(4).tolist()
            columns[col] = {"type": "number", "min": q[0], "p10": q[1], "p50": q[2], "p90": q[3], "max": q[4]}
        elif s.dtype.kind in "OSUb":
            counts = s.astype(str).value_counts()
            columns[col] = {"type": "string", "distinct": int(counts.size)}
            if counts.size <= 20:
                columns[col]["values"] = counts.to_dict()
    minx, miny, maxx, maxy = (round(v, 5) for v in gdf.total_bounds)
    return {
        "rows": len(gdf),
        "truncated": len(gdf) >= MAX_ROWS,
        "geometry_types": gdf.geom_type.value_counts().to_dict(),
        "bounds": [minx, miny, maxx, maxy],
        "center": [round((minx + maxx) / 2, 5), round((miny + maxy) / 2, 5)],
        "columns": columns,
    }


# ── Map tools ──────────────────────────────────────────────────

@tool
def write_layer(map_id: str, layer_id: str, sql: str) -> str:
    """Run a Wherobots SQL query and save the result as a GeoJSON layer for a map.

    The SELECT must include the `geometry` column plus only the columns the map
    styles or shows in popups. Results are capped at 10,000 rows; aggregate (e.g.
    H3 cells) for anything larger.

    Args:
        map_id: Map folder name, lowercase letters, digits, '-' or '_' (e.g. "critical-wildfire").
        layer_id: Layer file name within the map, same rules (e.g. "buildings").
        sql: Final Wherobots Spatial SQL query.

    Returns:
        JSON summary: row count, truncation flag, bounds, center, and per-column
        stats (numeric min/p10/p50/p90/max, string top values). Use it to choose
        colour stops, legend labels and the map center.
    """
    if not (_ID_RE.match(map_id) and _ID_RE.match(layer_id)):
        return "map_id and layer_id must be lowercase letters, digits, '-' or '_'."
    table = pq.read_table(io.BytesIO(_run_query_to_parquet(sql))).to_pandas()
    if "geometry" not in table.columns:
        return "The query result has no `geometry` column; include it in the SELECT."
    # geometry_bbox is a bounding-box column Wherobots adds to query results; maps don't need it.
    gdf = gpd.GeoDataFrame(table.drop(columns=["geometry", "geometry_bbox"], errors="ignore"),
                           geometry=shapely.from_wkb(table["geometry"]), crs=4326)
    for col in gdf.columns.drop("geometry"):
        if gdf[col].dtype.kind in "mM" or gdf[col].map(lambda v: isinstance(v, (bytes, dict, list))).any():
            gdf[col] = gdf[col].astype(str)
    out = MAPS_DIR / map_id / f"{layer_id}.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    return json.dumps({"file": f"{layer_id}.geojson", **_summarize(gdf)})


@tool
def publish_map(map_id: str, spec: dict) -> str:
    """Publish a map spec for the viewer and return the map URL.

    Args:
        map_id: Same map_id used with write_layer.
        spec: Map spec (see the open-mapping skill): title, description, center
            [lng, lat], zoom, basemap ("dark" or "light"), sources (MapLibre
            sources; GeoJSON `data` is the layer file name, e.g. "buildings.geojson"),
            layers (MapLibre layers), legend [{label, color}], popup [column names].

    Returns:
        The viewer URL, or a validation error to fix and retry.
    """
    if not _ID_RE.match(map_id):
        return "map_id must be lowercase letters, digits, '-' or '_'."
    map_dir = MAPS_DIR / map_id
    sources = spec.get("sources") or {}
    for sid, src in sources.items():
        data = src.get("data")
        if isinstance(data, str) and "://" not in data and not (map_dir / data).exists():
            return f"Source '{sid}' points at '{data}', which does not exist; call write_layer first."
    for layer in spec.get("layers") or []:
        if layer.get("source") not in sources:
            return f"Layer '{layer.get('id')}' uses unknown source '{layer.get('source')}'."
    if not spec.get("layers"):
        return "The spec needs at least one layer."
    map_dir.mkdir(parents=True, exist_ok=True)
    (map_dir / "map.json").write_text(json.dumps(spec, indent=1))
    # The live viewer (no ?map=) polls this pointer and swaps in the newest map.
    (MAPS_DIR / "current.json").write_text(
        json.dumps({"id": map_id, "map": f"maps/{map_id}/map.json", "updated": time.time()}))
    return (f"Published. The live viewer at http://localhost:{VIEWER_PORT} now shows it. "
            f"Permalink: http://localhost:{VIEWER_PORT}/?map=maps/{map_id}/map.json")


# ── System Prompt ──────────────────────────────────────────────
SYSTEM_PROMPT = f"""You are a geospatial map builder agent. You answer questions about San Diego
building risk with Wherobots Spatial SQL and publish each answer as an interactive map.

## Data (gold tables in the Wherobots catalog)

Query a table with: SELECT ... FROM org_catalog.{GOLD_DB}.<table>

- insurance_exposure: asset_id, geometry, building_class, wildfire_factor, flood_factor,
  severe_weather_factor, risk_score, risk_tier, exposure_delta, triage_priority, relative_risk_band
- cre_risk: asset_id, geometry, building_class, wildfire_factor, flood_factor, severe_weather_factor,
  risk_score, risk_tier, acquisition_screen_flag, exposure_magnitude_index, hazard_proximity_m
- capital_markets_signals: asset_id, geometry, building_class, wildfire_factor, flood_factor,
  severe_weather_factor, risk_score, disruption_signal, supply_chain_vulnerability, event_density_signal
  (NO risk_tier column)
- energy_asset_risk: asset_id, geometry, building_class, wildfire_factor, flood_factor,
  severe_weather_factor, risk_score, risk_tier, outage_probability, wildfire_ignition_risk,
  weather_impact_frequency

Risk tiers: critical, high, elevated, moderate, low. All geometry is WGS84 (lng/lat).
If unsure of a column, run SELECT * EXCEPT (geometry) ... LIMIT 1 first.

## Workflow

1. When the filter is clear, go straight to write_layer: it waits for the query itself and
   reports the row count and truncation. Only use the Wherobots MCP tools first when you need
   to discover columns or values; then call submit_query_tool with wait_seconds=55 and, if it
   is still running, call get_query_status_tool at most a few times rather than in a tight loop.
2. Call write_layer with the final SQL. Select geometry + only the columns you style or show.
   If the answer would exceed 10,000 rows, aggregate first (e.g. H3 cells with
   ST_H3CellIDs/ST_H3ToGeom, or centroids) or narrow the filter, and say so.
3. Read the summary write_layer returns and build the map spec from the REAL value ranges:
   colour stops from min/p50/max (never a fixed 0-1 if the data spans 0-0.4), categories from
   the top values, center from the summary.
4. Call publish_map. The user's live viewer updates on its own, so don't lead with a link:
   say the map is updated and what it shows in one or two sentences, and give the permalink
   only at the end for sharing.

For follow-ups ("make it light", "only above 0.3"), reuse the same map_id. Only call
write_layer again when the data changes; a styling change only needs publish_map.
Load the open-mapping skill for the spec format and the tier palette.

Users are underwriters, CRE and energy analysts, not GIS engineers: describe what the map
shows in their terms (buildings, risk tiers, neighbourhoods), not SQL, file formats or
function names.
"""


# ── Agent Factory ──────────────────────────────────────────────

def get_model():
    """Get the best available Bedrock model."""
    from strands.models.bedrock import BedrockModel
    return BedrockModel(
        model_id=os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-opus-4-8"),
        region_name=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2",
    )


def create_agent(wherobots_tools: list) -> Agent:
    return Agent(
        model=get_model(),
        system_prompt=SYSTEM_PROMPT,
        tools=[write_layer, publish_map] + wherobots_tools,
        plugins=[skills_plugin],
    )


def start_viewer() -> None:
    """Serve viewer/ (index.html + maps/) on localhost in a background thread."""
    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def end_headers(self):
            # Maps are rewritten in place on every publish; never serve a stale copy.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    handler = functools.partial(QuietHandler, directory=str(VIEWER_DIR))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", VIEWER_PORT), handler)
    except OSError:
        print(f"⚠️  Port {VIEWER_PORT} is busy; set MAP_VIEWER_PORT to a free port.")
        sys.exit(1)
    threading.Thread(target=server.serve_forever, daemon=True).start()


# ── CLI ────────────────────────────────────────────────────────

def _preflight():
    if not os.environ.get("WHEROBOTS_API_KEY", "").strip():
        print("❌ WHEROBOTS_API_KEY is not set in your .env.")
        sys.exit(1)
    import boto3
    try:
        boto3.client("sts").get_caller_identity()
    except Exception as e:
        print(f"❌ AWS credentials for Bedrock are not working: {e}")
        print("   Refresh them (e.g. `aws sso login --profile <profile>`), then re-run.")
        sys.exit(1)


def main():
    _preflight()
    start_viewer()
    print("🗺️  Open Map Agent (Wherobots MCP + MapLibre)")
    print("=" * 50)
    print(f"Open http://localhost:{VIEWER_PORT} and keep it open: it updates after every answer.")
    print("Type 'quit' to exit.\n")
    print("Examples:")
    print('  "Map critical insurance buildings colored by wildfire factor"')
    print('  "Show energy assets with outage probability above 0.5"')
    print()
    try:
        with wherobots_mcp:
            wherobots_tools = wherobots_mcp.list_tools_sync()
            print(f"✅ Wherobots MCP connected ({len(wherobots_tools)} tools available)")
            # Start the SQL session now so its cold start overlaps with the user typing.
            _mcp("submit_query_tool", {"query": "SELECT 1", "wait_seconds": 1})
            print("⏳ Compute is warming up; the first answer may still take a minute or two.\n")
            agent = create_agent(wherobots_tools)

            if len(sys.argv) > 1:
                prompt = " ".join(sys.argv[1:])
                print(f"🔍 {prompt}\n")
                agent(prompt)
                print()

            while True:
                try:
                    prompt = input("🔍 > ").strip()
                except (EOFError, KeyboardInterrupt):
                    print("\n👋 Bye!")
                    break
                if not prompt:
                    continue
                if prompt.lower() in ("quit", "exit", "q"):
                    print("👋 Bye!")
                    break
                print()
                agent(prompt)
                print()
    except MCPClientInitializationError:
        print(f"\n❌ Could not connect to the Wherobots MCP ({WHEROBOTS_MCP_URL}).")
        print("   Check WHEROBOTS_API_KEY in your .env, then re-run.")
        sys.exit(1)


if __name__ == "__main__":
    main()

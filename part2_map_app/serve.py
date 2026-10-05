#!/usr/bin/env python3
"""Run the San Diego map app locally: static files, the copilot (a Strands agent on Amazon
Bedrock) at /api/chat, and /api/query on your own Wherobots Gold tables through the Wherobots MCP.

    .venv/bin/python part2_map_app/serve.py          # then open http://localhost:8765

The agent has two kinds of tools. Map tools (copilot.json, shared with the Vercel api/chat.js)
run in the browser, because they change the map: the agent pauses on a Strands interrupt, the
browser runs the tool and posts the result back, and the agent resumes. Wherobots MCP tools run
here, so the agent can also answer free-form questions about your Gold tables in SQL. The model
runs on Bedrock with your AWS credentials and queries run in your Wherobots organization with
your WHEROBOTS_API_KEY; neither leaves this machine. The map tiles are read straight from the
public bucket by the browser.
"""
import functools
import io
import json
import math
import os
import sys
import threading
import time
import urllib.request
import uuid
from datetime import timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).parent
load_dotenv(APP_DIR.parent / ".env", override=True)

import boto3
import httpx2
import pyarrow.parquet as pq
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
from strands import Agent
from strands.interrupt import InterruptException
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from strands.types._events import ToolInterruptEvent, ToolResultEvent
from strands.types.tools import AgentTool, ToolContext

PORT = int(os.environ.get("MAP_APP_PORT", "8765"))
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-opus-4-8")
REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2"
MAX_PAYLOAD_CHARS = 100_000
MAX_SESSIONS = 50
# Wherobots MCP tools the agent gets: catalog discovery and read-only SQL.
MCP_TOOLS = {"list_catalogs_tool", "list_databases_tool", "list_tables_tool", "describe_table_tool",
             "submit_query_tool", "get_query_status_tool", "get_query_results_tool"}

WHEROBOTS_MCP_URL = os.environ.get("WHEROBOTS_MCP_URL", "https://api.cloud.wherobots.com/mcp")
GOLD = "org_catalog." + os.environ.get("GOLD_DB", "gold")
MAX_RADIUS_M = 20_000
MAX_LIMIT = 50

COPILOT = json.loads((APP_DIR / "copilot.json").read_text())
SYSTEM = COPILOT["system"] + f"""

SQL: for a question the map tools can't answer (counts with a condition, comparisons, a column the
map doesn't show), query the Gold tables yourself with the Wherobots tools: {GOLD}.insurance_exposure,
.cre_risk, .capital_markets_signals and .energy_asset_risk, joined on asset_id. Describe a table before
querying it, aggregate rather than list rows, and if submit_query_tool returns a running job, poll
get_query_status_tool, then fetch get_query_results_tool. Prefer the map tools when they fit: their
answers also show on the map. Never mention SQL or table names to the user."""
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

# The model picks a metric KEY; this map owns the column it sorts by, so model output never
# reaches the SQL as a free string.
METRICS = {
    "insurance": "i.risk_score", "cre": "c.risk_score", "capital_markets": "m.risk_score",
    "energy": "e.risk_score", "wildfire": "i.wildfire_factor", "flood": "i.flood_factor",
    "severe_weather": "i.severe_weather_factor", "outage_probability": "e.outage_probability",
}


class BrowserTool(AgentTool):
    """A map tool the browser runs: the agent pauses on an interrupt until the result comes back."""

    def __init__(self, spec):
        super().__init__()
        self._spec = {"name": spec["name"], "description": spec["description"],
                      "inputSchema": {"json": spec["input_schema"]}}

    @property
    def tool_name(self):
        return self._spec["name"]

    @property
    def tool_spec(self):
        return self._spec

    @property
    def tool_type(self):
        return "browser"

    async def stream(self, tool_use, invocation_state, **kwargs):
        ctx = ToolContext(tool_use=tool_use, agent=invocation_state["agent"], invocation_state=invocation_state)
        try:
            out = ctx.interrupt("browser-" + tool_use["toolUseId"],
                                reason={"name": self.tool_name, "input": tool_use["input"]})
        except InterruptException as e:
            yield ToolInterruptEvent(tool_use, [e.interrupt])
            return
        yield ToolResultEvent({"toolUseId": tool_use["toolUseId"], "status": "success", "content": [{"json": out}]})


sessions = {}   # browser session id -> (Agent, lock); one conversation per open page


def new_agent():
    tools = [BrowserTool(t) for t in COPILOT["tools"]]
    tools += [t for t in wherobots_mcp.list_tools_sync() if t.tool_name in MCP_TOOLS]
    return Agent(model=BedrockModel(model_id=MODEL_ID, region_name=REGION, max_tokens=2048),
                 system_prompt=SYSTEM, tools=tools, callback_handler=None)


def chat(body):
    """One turn: a new user message, or the browser's results for the map tools the agent asked for.
    Returns the agent's text and, if it paused for the browser, the map tools to run."""
    sid = str(body.get("session") or "")
    if sid not in sessions:
        if len(sessions) >= MAX_SESSIONS:
            sessions.pop(next(iter(sessions)))
        sessions[sid] = (new_agent(), threading.Lock())
    agent, lock = sessions[sid]
    if body.get("results"):
        prompt = [{"interruptResponse": {"interruptId": r["id"], "response": r["output"]}} for r in body["results"]]
    else:
        prompt = str(body.get("message") or "")
    with lock:
        r = agent(prompt)
    text = "\n".join(c["text"] for c in (r.message or {}).get("content", []) if "text" in c).strip()
    calls = [{"id": i.id, **i.reason} for i in (r.interrupts or [])]
    return {"text": text, "tool_calls": calls}


def _mcp(name, arguments):
    """Call a Wherobots MCP tool and return its JSON payload."""
    r = wherobots_mcp.call_tool_sync(
        tool_use_id=f"app-{uuid.uuid4().hex[:8]}", name=name, arguments=arguments,
        read_timeout_seconds=timedelta(seconds=90),
    )
    text = "".join(c.get("text", "") for c in r.get("content", []) if isinstance(c, dict))
    if r.get("status") == "error":
        raise RuntimeError(f"{name} failed: {text[:500]}")
    payload = r.get("structuredContent") or json.loads(text)
    return payload.get("result", payload) if "status" not in payload else payload


def building_sql(lon, lat, radius_m, metric, limit):
    """The one statement the app runs: top buildings within a radius, from a fixed template."""
    dlat = radius_m / 111_320
    dlon = dlat / max(math.cos(math.radians(lat)), 0.01)
    pt = f"ST_Point({lon!r}, {lat!r})"
    return f"""
SELECT i.asset_id AS building_id, i.risk_score AS ins_score, i.risk_tier AS ins_tier,
       c.risk_score AS cre_score, c.risk_tier AS cre_tier, m.risk_score AS cap_score,
       e.risk_score AS en_score, e.risk_tier AS en_tier, i.wildfire_factor, i.flood_factor,
       i.severe_weather_factor, e.outage_probability,
       ST_X(ST_Centroid(i.geometry)) AS lon, ST_Y(ST_Centroid(i.geometry)) AS lat,
       ST_DistanceSphere(ST_Centroid(i.geometry), {pt}) AS dist_m
FROM {GOLD}.insurance_exposure i
JOIN {GOLD}.cre_risk c ON i.asset_id = c.asset_id
JOIN {GOLD}.capital_markets_signals m ON i.asset_id = m.asset_id
JOIN {GOLD}.energy_asset_risk e ON i.asset_id = e.asset_id
WHERE ST_Intersects(i.geometry, ST_PolygonFromEnvelope({lon - dlon!r}, {lat - dlat!r}, {lon + dlon!r}, {lat + dlat!r}))
  AND ST_DistanceSphere(ST_Centroid(i.geometry), {pt}) <= {float(radius_m)!r}
ORDER BY {METRICS[metric]} DESC, i.asset_id
LIMIT {int(limit)}"""


def query_buildings(args):
    """Validate the copilot's arguments, run the template through the Wherobots MCP, return rows."""
    try:
        lon, lat = float(args["lon"]), float(args["lat"])
        radius_m, limit = float(args["radius_m"]), int(args.get("limit") or 10)
    except (KeyError, TypeError, ValueError):
        return {"error": "lon, lat and radius_m must be numbers"}
    metric = args.get("metric") or "insurance"
    if metric not in METRICS:
        return {"error": "metric must be one of: " + ", ".join(METRICS)}
    if not (-118 < lon < -116 and 32 < lat < 34) or radius_m <= 0 or limit <= 0:
        return {"error": "the centre must be in San Diego and radius_m and limit must be positive"}
    clamps = []
    if radius_m > MAX_RADIUS_M:
        clamps.append(f"radius_m clamped from {radius_m:g} to {MAX_RADIUS_M}")
        radius_m = MAX_RADIUS_M
    if limit > MAX_LIMIT:
        clamps.append(f"limit clamped from {limit} to {MAX_LIMIT}")
        limit = MAX_LIMIT
    t0 = time.time()
    job = _mcp("submit_query_tool", {"query": building_sql(lon, lat, radius_m, metric, limit),
                                     "store_results": True, "limit": limit, "wait_seconds": 50})
    while job.get("status") in ("pending", "starting_session", "running"):
        time.sleep(5)
        job = _mcp("get_query_status_tool", {"query_id": job["query_id"]})
    if job.get("status") != "succeeded":
        return {"error": f"query {job.get('status')}: {job.get('error_message')}"}
    if not job.get("result_uri"):
        job = _mcp("get_query_results_tool", {"query_id": job["query_id"]})
    with urllib.request.urlopen(job["result_uri"], timeout=120) as resp:
        rows = pq.read_table(io.BytesIO(resp.read())).to_pylist()
    return {"rows": rows, "metric": metric, "radius_m": radius_m, "clamps": clamps,
            "query_id": job["query_id"], "seconds": round(time.time() - t0, 1)}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path not in ("/api/chat", "/api/query"):
            return self._json(404, {"error": "not found"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/query":
            try:
                return self._json(200, query_buildings(json.loads(raw or b"{}")))
            except Exception as e:  # surface Wherobots errors (bad key, missing Gold tables) to the chat
                return self._json(502, {"error": f"{type(e).__name__}: {e}"})
        if len(raw) > MAX_PAYLOAD_CHARS:
            return self._json(413, {"error": "message payload too large"})
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self._json(400, {"error": "invalid JSON"})
        if not body.get("message") and not body.get("results"):
            return self._json(400, {"error": "no message provided"})
        try:
            return self._json(200, chat(body))
        except Exception as e:  # surface Bedrock errors (expired credentials, model access) to the chat
            return self._json(502, {"error": f"{type(e).__name__}: {e}"})


def main():
    if not os.environ.get("WHEROBOTS_API_KEY", "").strip():
        print("❌ WHEROBOTS_API_KEY is not set in your .env.")
        sys.exit(1)
    try:
        boto3.client("sts", region_name=REGION).get_caller_identity()
    except Exception as e:
        print(f"❌ AWS credentials for Bedrock are not working: {e}")
        print("   Refresh them (e.g. `aws sso login --profile <profile>`), then re-run.")
        sys.exit(1)
    wherobots_mcp.start()
    # Start the SQL session now so its cold start overlaps with the first look at the map.
    threading.Thread(target=_mcp, args=("submit_query_tool", {"query": "SELECT 1", "wait_seconds": 1}),
                     daemon=True).start()
    handler = functools.partial(Handler, directory=str(APP_DIR))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    except OSError:
        print(f"⚠️  Port {PORT} is busy; set MAP_APP_PORT to a free port.")
        sys.exit(1)
    print(f"🗺️  San Diego risk map: http://localhost:{PORT}  (Strands agent, {MODEL_ID} on Bedrock, {REGION}; "
          f"building queries on {GOLD} via the Wherobots MCP)")
    print("   Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Bye!")
    finally:
        wherobots_mcp.stop(None, None, None)


if __name__ == "__main__":
    main()

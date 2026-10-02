// Building queries for the Vercel deploy: the same fixed SQL template as serve.py, run on your
// Wherobots Gold tables through the Wherobots MCP with WHEROBOTS_API_KEY (and optionally
// WHEROBOTS_RUNTIME_ID, e.g. "micro") set on the deployment. Speaks MCP's streamable HTTP
// transport with plain fetch, so the deploy needs no dependencies.
const MCP_URL = process.env.WHEROBOTS_MCP_URL || "https://api.cloud.wherobots.com/mcp";
const GOLD = "org_catalog." + (process.env.GOLD_DB || "gold");
const MAX_RADIUS_M = 20000, MAX_LIMIT = 50;
const METRICS = { insurance:"i.risk_score", cre:"c.risk_score", capital_markets:"m.risk_score", energy:"e.risk_score",
  wildfire:"i.wildfire_factor", flood:"i.flood_factor", severe_weather:"i.severe_weather_factor",
  outage_probability:"e.outage_probability" };

export const config = { maxDuration: 300 };

function buildingSql(lon, lat, radius, metric, limit){
  const dlat = radius / 111320, dlon = dlat / Math.max(Math.cos(lat * Math.PI / 180), 0.01);
  const pt = `ST_Point(${lon}, ${lat})`;
  return `
SELECT i.asset_id AS building_id, i.risk_score AS ins_score, i.risk_tier AS ins_tier,
       c.risk_score AS cre_score, c.risk_tier AS cre_tier, m.risk_score AS cap_score,
       e.risk_score AS en_score, e.risk_tier AS en_tier, i.wildfire_factor, i.flood_factor,
       i.severe_weather_factor, e.outage_probability,
       ST_X(ST_Centroid(i.geometry)) AS lon, ST_Y(ST_Centroid(i.geometry)) AS lat,
       ST_DistanceSphere(ST_Centroid(i.geometry), ${pt}) AS dist_m
FROM ${GOLD}.insurance_exposure i
JOIN ${GOLD}.cre_risk c ON i.asset_id = c.asset_id
JOIN ${GOLD}.capital_markets_signals m ON i.asset_id = m.asset_id
JOIN ${GOLD}.energy_asset_risk e ON i.asset_id = e.asset_id
WHERE ST_Intersects(i.geometry, ST_PolygonFromEnvelope(${lon - dlon}, ${lat - dlat}, ${lon + dlon}, ${lat + dlat}))
  AND ST_DistanceSphere(ST_Centroid(i.geometry), ${pt}) <= ${radius}
ORDER BY ${METRICS[metric]} DESC, i.asset_id
LIMIT ${limit}`;
}

async function mcpSession(key){
  const headers = { "content-type":"application/json", accept:"application/json, text/event-stream", "x-api-key":key };
  if(process.env.WHEROBOTS_RUNTIME_ID) headers["x-runtime-id"] = process.env.WHEROBOTS_RUNTIME_ID;
  let id = 0;
  async function rpc(method, params, notify){
    const r = await fetch(MCP_URL, { method:"POST", headers,
      body:JSON.stringify(notify ? { jsonrpc:"2.0", method, params } : { jsonrpc:"2.0", id:++id, method, params }) });
    if(!r.ok && r.status !== 202) throw new Error(`MCP ${method}: HTTP ${r.status}`);
    if(r.headers.get("mcp-session-id")) headers["mcp-session-id"] = r.headers.get("mcp-session-id");
    if(notify) return null;
    const text = await r.text();
    const json = (r.headers.get("content-type") || "").includes("text/event-stream")
      ? text.split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))).find(m => m.id === id)
      : JSON.parse(text);
    if(json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
    return json.result;
  }
  await rpc("initialize", { protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{ name:"sd-map-app", version:"1" } });
  await rpc("notifications/initialized", {}, true);
  return async (name, args) => {
    const res = await rpc("tools/call", { name, arguments:args });
    const text = (res.content || []).map(c => c.text || "").join("");
    if(res.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
    const p = res.structuredContent || JSON.parse(text);
    return "status" in p ? p : (p.result || p);
  };
}

export default async function handler(req, res){
  if(req.method !== "POST"){ res.status(405).json({error:"POST only"}); return; }
  const key = process.env.WHEROBOTS_API_KEY;
  if(!key){ res.status(500).json({error:"WHEROBOTS_API_KEY is not set on this deployment."}); return; }
  if(process.env.APP_SECRET && req.headers["x-app-secret"] !== process.env.APP_SECRET){ res.status(401).json({error:"unauthorized"}); return; }
  let b = req.body;
  if(!b || typeof b === "string"){ try{ b = JSON.parse(b || "{}"); }catch(e){ b = {}; } }
  const lon = Number(b.lon), lat = Number(b.lat), metric = b.metric || "insurance";
  let radius = Number(b.radius_m), limit = Number(b.limit || 10);
  if(!METRICS[metric]){ res.json({error:"metric must be one of: " + Object.keys(METRICS).join(", ")}); return; }
  if(!(lon > -118 && lon < -116 && lat > 32 && lat < 34) || !(radius > 0) || !Number.isInteger(limit) || limit <= 0){
    res.json({error:"the centre must be in San Diego and radius_m and limit must be positive"}); return; }
  const clamps = [];
  if(radius > MAX_RADIUS_M){ clamps.push(`radius_m clamped from ${radius} to ${MAX_RADIUS_M}`); radius = MAX_RADIUS_M; }
  if(limit > MAX_LIMIT){ clamps.push(`limit clamped from ${limit} to ${MAX_LIMIT}`); limit = MAX_LIMIT; }
  const t0 = Date.now();
  try{
    const call = await mcpSession(key);
    let job = await call("submit_query_tool", { query:buildingSql(lon, lat, radius, metric, limit), limit, wait_seconds:50 });
    while(["pending", "starting_session", "running"].includes(job.status)){
      await new Promise(r => setTimeout(r, 5000));
      job = await call("get_query_status_tool", { query_id:job.query_id });
    }
    if(job.status !== "succeeded"){ res.json({error:`query ${job.status}: ${job.error_message}`}); return; }
    // Inline rows are capped at ~16 KB per response, so page through the stored result.
    const rows = job.data || [];
    while(rows.length < (job.total_row_count ?? rows.length + 1)){
      const page = await call("get_query_results_tool", { query_id:job.query_id, offset:rows.length, limit:limit - rows.length });
      if(!page.data || !page.data.length) break;
      rows.push(...page.data); job.total_row_count = page.total_row_count;
    }
    res.json({ rows, metric, radius_m:radius, clamps, query_id:job.query_id,
               seconds:Math.round((Date.now() - t0) / 100) / 10 });
  }catch(e){
    res.status(502).json({error:String(e && e.message || e)});
  }
}

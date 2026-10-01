// San Diego Risk Copilot — Anthropic Messages API proxy for the Vercel deploy (holds the key
// server-side). The system prompt and tool schemas live in ../copilot.json, shared with
// serve.py, which runs the same copilot on Amazon Bedrock for the local workshop. The browser
// executes the returned tool_use calls against the MapLibre map and posts back tool_results.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COPILOT = JSON.parse(readFileSync(join(process.cwd(), "copilot.json"), "utf8"));
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// --- Best-effort per-IP + global rate limiting (in-memory, per warm instance) ---
// Serverless instances are ephemeral and can run in parallel, so this is a speed bump, not a
// hard guarantee. The real backstop against cost abuse is a monthly SPEND CAP on the Anthropic
// key (console.anthropic.com -> Limits).
const RL_WINDOW_MS = 60000;   // 1 minute window
const RL_PER_IP = 15;         // max requests per IP per window
const RL_GLOBAL = 400;        // max requests across this instance per window (circuit breaker)
const MAX_MESSAGES = 40;      // reject absurdly long conversations
const MAX_PAYLOAD_CHARS = 100000; // reject oversized payloads (cost-abuse guard)
const ipHits = new Map();     // ip -> [timestamps]
let globalHits = [];          // [timestamps]
function clientIp(req){
  const xf = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xf) ? xf[0] : (xf || "")).split(",")[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || "unknown";
}
function rateCheck(ip){
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < RL_WINDOW_MS);
  if(globalHits.length >= RL_GLOBAL) return { limited:true, scope:"global" };
  let arr = (ipHits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if(arr.length >= RL_PER_IP){ ipHits.set(ip, arr); return { limited:true, scope:"ip" }; }
  arr.push(now); ipHits.set(ip, arr); globalHits.push(now);
  if(ipHits.size > 5000){ for(const [k,v] of ipHits){ const f = v.filter(t => now - t < RL_WINDOW_MS); if(f.length) ipHits.set(k,f); else ipHits.delete(k); } }
  return { limited:false };
}

export default async function handler(req, res){
  if(req.method !== "POST"){ res.status(405).json({error:"POST only"}); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key){ res.status(500).json({error:"ANTHROPIC_API_KEY is not set on this deployment."}); return; }
  if(process.env.APP_SECRET && req.headers["x-app-secret"] !== process.env.APP_SECRET){ res.status(401).json({error:"unauthorized"}); return; }
  const rl = rateCheck(clientIp(req));
  if(rl.limited){ res.setHeader("Retry-After","30"); res.status(429).json({error: rl.scope==="global" ? "The copilot is busy right now — please try again in a moment." : "You're sending messages too quickly — please wait a few seconds and try again."}); return; }
  let body = req.body;
  if(!body || typeof body === "string"){ try{ body = JSON.parse(body||"{}"); }catch(e){ body = {}; } }
  const messages = (body && body.messages) || [];
  if(!Array.isArray(messages) || messages.length === 0){ res.status(400).json({error:"no messages provided"}); return; }
  if(messages.length > MAX_MESSAGES){ res.status(400).json({error:"conversation too long — start a new chat"}); return; }
  if(JSON.stringify(messages).length > MAX_PAYLOAD_CHARS){ res.status(413).json({error:"message payload too large"}); return; }
  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1024,
        system: [{ type:"text", text: COPILOT.system, cache_control:{ type:"ephemeral" } }],
        tools: COPILOT.tools,
        messages
      })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  }catch(e){ res.status(502).json({error:String(e)}); }
}

#!/usr/bin/env python3
"""Regenerate the app files that depend on the published data.

    python3 part2_map_app/data/build_app_data.py <version>

Reads places.json (copied next to index.html by publish.py) and writes:
  - copilot.json        system prompt (with the per-place table) and tool schemas, shared by
                        serve.py (Bedrock) and api/chat.js (Anthropic API)
  - query/gazetteer.js  the PLACES block between the GAZETTEER markers
  - index.html          DATA_VERSION
Every number the copilot may quote comes from places.json, so the prompt can't drift from the map.
"""
import json
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
LANDMARKS = {   # names people use that are not Overture places
    "downtown san diego": [-117.1625, 32.7157], "balboa park": [-117.1466, 32.7341],
    "san diego airport": [-117.1933, 32.7338], "la jolla": [-117.2713, 32.8328],
    "mission trails": [-117.0548, 32.8353], "mission trails regional park": [-117.0548, 32.8353],
    "tierrasanta": [-117.0905, 32.8240], "scripps ranch": [-117.1040, 32.9140],
    "rancho bernardo": [-117.0723, 33.0198], "san carlos": [-117.0300, 32.7980],
    "del cerro": [-117.0700, 32.7880], "pacific beach": [-117.2357, 32.7976],
}

PERIL_TOOLS = [
    {"name": "set_lens", "description": "Switch the map's industry lens. Each lens weights wildfire, flood and severe weather differently.",
     "input_schema": {"type": "object", "properties": {"lens": {"type": "string", "enum": ["insurance", "cre", "capital_markets", "energy"]}}, "required": ["lens"]}},
    {"name": "set_hazard", "description": "Colour the map by the lens's overall risk ('risk') or by one hazard factor.",
     "input_schema": {"type": "object", "properties": {"hazard": {"type": "string", "enum": ["risk", "wildfire", "flood", "severe_weather"]}}, "required": ["hazard"]}},
    {"name": "focus_place", "description": "Fly to one City of San Diego neighbourhood and return its counts.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "fit_city", "description": "Zoom back out to the whole city.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_map_state", "description": "Return the current lens, colour mode, zoom and centre.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "find_top_places", "description": "Rank neighbourhoods for a lens: by critical building count (default), share of critical buildings, wildfire-exposed buildings, or mean score. Marks them on the map.",
     "input_schema": {"type": "object", "properties": {
         "lens": {"type": "string", "enum": ["insurance", "cre", "capital_markets", "energy"]},
         "by": {"type": "string", "enum": ["critical", "share", "wildfire_exposed", "avg_score"]},
         "n": {"type": "integer", "description": "1-25, default 10"}}}},
    {"name": "find_hexes", "description": "Find the highest-risk H3 cells (~0.7 km² each) for a lens or hazard, optionally within one neighbourhood; highlights them and fits the map.",
     "input_schema": {"type": "object", "properties": {
         "lens": {"type": "string", "enum": ["insurance", "cre", "capital_markets", "energy"]},
         "hazard": {"type": "string", "enum": ["risk", "wildfire", "flood", "severe_weather"]},
         "place": {"type": "string"}, "n": {"type": "integer", "description": "1-25, default 10"}}}},
    {"name": "clear_highlights", "description": "Remove highlight markers and query results from the map.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "query_properties", "description": "Building-level question: the top N buildings within a radius of a place or point, ranked by a metric. Runs spatial SQL on the user's own Wherobots Gold tables through the Wherobots MCP and shows numbered markers.",
     "input_schema": {"type": "object", "properties": {
         "place": {"type": "string", "description": "A City of San Diego neighbourhood or landmark, e.g. 'Scripps Ranch', 'downtown San Diego'. Preferred."},
         "lon": {"type": "number"}, "lat": {"type": "number"},
         "radius_m": {"type": "number", "description": "Radius in METRES (1 mile = 1609.34). Max 20000."},
         "metric": {"type": "string", "enum": ["insurance", "cre", "capital_markets", "energy", "wildfire", "flood", "severe_weather", "outage_probability"]},
         "limit": {"type": "integer", "description": "1-50, default 10"},
         "place_label": {"type": "string"}}, "required": ["radius_m"]}},
]


def system_prompt(places, total):
    table = [{"place": p["place"], "buildings": p["buildings"],
              "ins_critical": p["ins_critical"], "ins_high": p["ins_high"], "cre_critical": p["cre_critical"],
              "en_critical": p["en_critical"], "wildfire_exposed": p["wildfire_exposed"],
              "avg_ins": p["avg_ins_score"], "avg_wf": p["avg_wildfire"]} for p in places]
    return "\n".join([
        "You are the San Diego Risk Copilot, embedded in an interactive building-risk map for an insurance, real-estate and utilities audience. You explain the data AND drive the map with tools.",
        "",
        f"CITY OF SAN DIEGO: {total:,} buildings scored for wildfire, flood and severe weather by the workshop's Wherobots pipeline, with four industry lenses: insurance, cre (commercial real estate), capital_markets and energy.",
        "",
        "PER-PLACE DATA (authoritative; quote only these numbers or tool results). Places are Overture neighbourhoods; each building belongs to the nearest one. ins_critical/ins_high/cre_critical/en_critical are building counts in that tier; wildfire_exposed = buildings with any wildfire factor; avg_ins and avg_wf are means:",
        json.dumps(table, separators=(",", ":")),
        "",
        "HARD RULES:",
        "- Tiers are PERCENTILE RANKS within the city (top 5% critical, next 15% high), not absolute thresholds and not insurability determinations. Never call anything insurable or uninsurable.",
        "- Flood is satellite-observed water from December 2025 to March 2026, so it is zero for almost every building. Say so instead of implying flood safety.",
        "- capital_markets has no tier, only a score.",
        "- There are no dollar values in this data; never rank by dollars.",
        "- Never invent a number. Use the table above, find_top_places, find_hexes or query_properties.",
        "",
        "TOOLS: when the user wants to see something, USE the tools (set_lens, set_hazard, focus_place, find_top_places, find_hexes). For questions about individual buildings ('top 10 buildings near Ramona by wildfire'), call query_properties with a place name and a radius; it runs SQL on the user's own Wherobots Gold tables, and the first query starts compute (about a minute), so warn once that the first answer is slower.",
        "",
        "STYLE: concise, plainspoken, decision-oriented. Lead with the number. No preamble. The chat shows PLAIN TEXT: no markdown, no bold, no tables; use short lines or a simple numbered list, and keep answers under about 120 words. The map and the results panel already show the full list, so summarise rather than repeat it.",
    ])


def main():
    version = sys.argv[1]
    data = json.loads((APP / "places.json").read_text())
    places, total = data["places"], data["total_buildings"]
    (APP / "copilot.json").write_text(json.dumps({"version": version, "system": system_prompt(places, total),
                                                  "tools": PERIL_TOOLS}, indent=1) + "\n")
    entries = {p["place"].lower(): [p["lon"], p["lat"]] for p in places}
    entries.update(LANDMARKS)
    block = ",\n".join(f'    {json.dumps(k)}: [{v[0]}, {v[1]}]' for k, v in sorted(entries.items()))
    g = (APP / "query" / "gazetteer.js").read_text()
    g = re.sub(r"(/\* GAZETTEER:BEGIN \*/\n).*?(\s*/\* GAZETTEER:END \*/)", lambda m: m.group(1) + block + "\n" + m.group(2).lstrip("\n"), g, flags=re.S)
    (APP / "query" / "gazetteer.js").write_text(g)
    html = (APP / "index.html").read_text()
    html = re.sub(r'const DATA_VERSION = "[^"]*";', f'const DATA_VERSION = "{version}";', html)
    (APP / "index.html").write_text(html)
    print(f"copilot.json: {len(places)} places, {total:,} buildings; gazetteer: {len(entries)} names; DATA_VERSION={version}")


if __name__ == "__main__":
    main()

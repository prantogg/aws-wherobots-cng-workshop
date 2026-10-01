#!/usr/bin/env python3
"""Run the San Diego map app locally: static files plus /api/chat on Amazon Bedrock.

    python part2_map_app/serve.py          # then open http://localhost:8765

The copilot's system prompt and tools live in copilot.json, shared with api/chat.js (the
Vercel version, which calls the Anthropic API with your own key instead). The model runs on
Bedrock with your AWS credentials, which never leave this machine; the map data is read
straight from the public bucket by the browser.
"""
import functools
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).parent
load_dotenv(APP_DIR.parent / ".env", override=True)

import boto3

PORT = int(os.environ.get("MAP_APP_PORT", "8765"))
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-opus-4-8")
REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2"
MAX_MESSAGES = 40
MAX_PAYLOAD_CHARS = 100_000

COPILOT = json.loads((APP_DIR / "copilot.json").read_text())
bedrock = boto3.client("bedrock-runtime", region_name=REGION)


def chat(messages):
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "system": COPILOT["system"],
        "tools": COPILOT["tools"],
        "messages": messages,
    }
    r = bedrock.invoke_model(modelId=MODEL_ID, body=json.dumps(body))
    return json.loads(r["body"].read())


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
        if self.path != "/api/chat":
            return self._json(404, {"error": "not found"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            messages = json.loads(raw or b"{}").get("messages") or []
        except ValueError:
            return self._json(400, {"error": "invalid JSON"})
        if not isinstance(messages, list) or not messages:
            return self._json(400, {"error": "no messages provided"})
        if len(messages) > MAX_MESSAGES:
            return self._json(400, {"error": "conversation too long — start a new chat"})
        if len(raw) > MAX_PAYLOAD_CHARS:
            return self._json(413, {"error": "message payload too large"})
        try:
            return self._json(200, chat(messages))
        except Exception as e:  # surface Bedrock errors (expired credentials, model access) to the chat
            return self._json(502, {"error": f"{type(e).__name__}: {e}"})


def main():
    try:
        boto3.client("sts", region_name=REGION).get_caller_identity()
    except Exception as e:
        print(f"❌ AWS credentials for Bedrock are not working: {e}")
        print("   Refresh them (e.g. `aws sso login --profile <profile>`), then re-run.")
        sys.exit(1)
    handler = functools.partial(Handler, directory=str(APP_DIR))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    except OSError:
        print(f"⚠️  Port {PORT} is busy; set MAP_APP_PORT to a free port.")
        sys.exit(1)
    print(f"🗺️  San Diego risk map: http://localhost:{PORT}  (model: {MODEL_ID} on Bedrock, {REGION})")
    print("   Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Bye!")


if __name__ == "__main__":
    main()

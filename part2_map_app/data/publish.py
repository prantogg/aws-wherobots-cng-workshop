#!/usr/bin/env python3
"""Copy an export run from Wherobots managed storage to the public app bucket.

    set -a; source .env; set +a                        # WHEROBOTS_API_KEY
    AWS_PROFILE=<profile> python3 part2_map_app/data/publish.py <version> [--dry-run]

Reads <managed>/cng-app/v<version>/ (written by export_sd_app_data.py) and lays it out as the
app expects:

    s3://<bucket>/sd/v<version>/tiles/*.pmtiles
    s3://<bucket>/sd/query/sd_risk_query.v<version>/manifest.json
    s3://<bucket>/sd/query/sd_risk_query.v<version>/cell=<h3_5>/part.parquet
    s3://<bucket>/sd/query/sd_risk_query.latest.json      (written last)

and copies app/hexes.json and app/places.json next to index.html. Versions are immutable: an
existing manifest for <version> stops the run. The Wherobots API key is only ever sent to the
Wherobots API; download redirects are followed without it.
"""
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import boto3

API = "https://api.cloud.wherobots.com"
BUCKET = os.environ.get("APP_BUCKET", "wherobots-cng-workshop-sd-uw2")
REGION = "us-west-2"
APP_DIR = Path(__file__).resolve().parent.parent
KEY = os.environ["WHEROBOTS_API_KEY"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_no_redirect = urllib.request.build_opener(NoRedirect)


def api(path, query=None):
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def managed():
    st = api("/storage")
    st = st if isinstance(st, list) else st.get("items") or []
    m = next(i for i in st if i.get("type") == "MANAGED")
    return m["id"], (m.get("defaultDirectory") or "").strip("/")


def list_files(storage_id, path):
    """Every file under `path`, recursively, as paths relative to it."""
    out, stack = [], [""]
    while stack:
        rel = stack.pop()
        q = urllib.parse.quote(f"{path}/{rel}".rstrip("/") + "/", safe="")
        cursor = None
        while True:
            listing = api(f"/storage/{storage_id}/directories/{q}", {"cursor": cursor} if cursor else None)
            for item in listing.get("items") or []:
                child = rel + item["name"].rstrip("/")
                if item.get("type") == "FILE":
                    out.append(child)
                else:
                    stack.append(child + "/")
            cursor = listing.get("next_page")
            if not cursor:
                break
    return sorted(out)


def download(storage_id, path, dest):
    q = urllib.parse.quote(path, safe="")
    req = urllib.request.Request(f"{API}/storage/{storage_id}/files/{q}", headers={"X-API-Key": KEY})
    try:
        _no_redirect.open(req, timeout=60)
        raise RuntimeError(f"expected a redirect for {path}")
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        signed = e.headers["Location"]
    with urllib.request.urlopen(signed, timeout=600) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def content_type(name):
    return "application/json" if name.endswith(".json") else "application/octet-stream"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    version = args[0]
    storage_id, default_dir = managed()
    root = f"/{default_dir}/cng-app/v{version}"
    files = list_files(storage_id, root)
    print(f"{len(files)} files under {root}")

    s3 = boto3.client("s3", region_name=REGION)
    qprefix = f"sd/query/sd_risk_query.v{version}/"
    try:
        s3.head_object(Bucket=BUCKET, Key=qprefix + "manifest.json")
        sys.exit(f"version {version} is already published; versions are immutable")
    except s3.exceptions.ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchKey", "403"):
            raise

    plan = []
    for f in files:
        if f.startswith("tiles/"):
            plan.append((f, f"sd/v{version}/{f}"))
        elif f.startswith("query/") and "/_tmp_" not in f:
            plan.append((f, qprefix + f[len("query/"):]))
        elif f.startswith("app/"):
            plan.append((f, None))
    manifest = [p for p in plan if p[0] == "query/manifest.json"]
    plan = [p for p in plan if p[0] != "query/manifest.json"] + manifest   # manifest after its files
    for src, dst in plan:
        print(f"  {src} -> {dst or 'part2_map_app/' + Path(src).name}")
    if dry:
        return

    with tempfile.TemporaryDirectory() as tmp:
        for src, dst in plan:
            local = Path(tmp) / src.replace("/", "_")
            download(storage_id, f"{root}/{src}", local)
            if dst is None:
                (APP_DIR / Path(src).name).write_bytes(local.read_bytes())
            else:
                s3.upload_file(str(local), BUCKET, dst, ExtraArgs={"ContentType": content_type(dst)})
            local.unlink()
    s3.put_object(Bucket=BUCKET, Key="sd/query/sd_risk_query.latest.json",
                  Body=json.dumps({"version": version}).encode(), ContentType="application/json",
                  CacheControl="no-cache")
    print(f"published v{version} to s3://{BUCKET}/sd/")


if __name__ == "__main__":
    main()
